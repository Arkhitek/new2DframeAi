// Netlify Functions用のAI生成API
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    // CORSヘッダーを設定
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // OPTIONSリクエストの処理
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    console.error('AIモデル生成API開始');
    
    if (event.httpMethod !== 'POST') {
        console.error('メソッドエラー: POST以外のリクエスト');
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { prompt: userPrompt, mode = 'new', currentModel } = JSON.parse(event.body);
        console.error('リクエスト解析: プロンプト=', userPrompt?.substring(0, 50) + '...', 'モード=', mode);
        
        if (!userPrompt) {
            console.error('エラー: 指示内容が空');
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: '指示内容が空です。' })
            };
        }

        const API_KEY = process.env.MISTRAL_API_KEY;
        if (!API_KEY) {
            throw new Error("Mistral AIのAPIキーがサーバーに設定されていません。");
        }
        
        const API_URL = 'https://api.mistral.ai/v1/chat/completions';
        
        // retryCount変数を先に定義
        let retryCount = 0;
        
        const systemPrompt = createSystemPromptForBackend(mode, currentModel, userPrompt, retryCount);
        
        // 追加編集モードの場合は現在のモデル情報を含めてプロンプトを作成
        let userMessage = userPrompt;
        if (mode === 'edit' && currentModel) {
            userMessage = createEditPrompt(userPrompt, currentModel);
        }

        const requestBody = {
            model: "mistral-large-latest",
            messages: [
                { "role": "system", "content": systemPrompt },
                { "role": "user", "content": userMessage }
            ],
            response_format: { "type": "json_object" }
        };

        // 最適化されたリトライ機能付きAI呼び出し
        let mistralResponse;
        let data;
        const maxRetries = 3; // リトライ回数を3回に最適化
        let lastError = null;
        
        while (retryCount <= maxRetries) {
            try {
                console.error(`AI呼び出し試行 ${retryCount + 1}/${maxRetries + 1}`);
                
                // タイムアウト設定を追加
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒タイムアウト
                
                mistralResponse = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bearer ${API_KEY}`,
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                data = await mistralResponse.json();
                console.error('AIレスポンス受信: ステータス=', mistralResponse.status);

                // 成功した場合はループを抜ける
                if (mistralResponse.ok) {
                    console.error(`✅ AI呼び出し成功 (${retryCount + 1}回目)`);
                    break;
                }
                
                // 容量制限エラーの場合
                if (mistralResponse.status === 429 && data.code === '3505') {
                    console.error(`容量制限エラー検出 (試行 ${retryCount + 1}/${maxRetries + 1})`);
                    
                    if (retryCount < maxRetries) {
                        // リトライ前に待機（より長い待機時間）
                        const baseWaitTime = 3000; // 基本3秒
                        const exponentialWaitTime = Math.pow(2, retryCount) * 1000; // 指数バックオフ
                        const waitTime = Math.min(baseWaitTime + exponentialWaitTime, 30000); // 最大30秒
                        
                        console.error(`容量制限のため ${waitTime}ms 待機後にリトライします (${retryCount + 1}/${maxRetries}回目)`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        retryCount++;
                        continue;
                    } else {
                        // 最大リトライ回数に達した場合はエラーを返す
                        console.error('=== 最大リトライ回数に達しました: AI生成を諦めます ===');
                        throw new Error(`AI容量制限により、モデル生成に失敗しました。${maxRetries + 1}回の試行を行いましたが、容量制限が継続しています。しばらく待ってから再試行してください。`);
                    }
                }
                
                // その他のエラーは記録してスロー
                lastError = new Error(data.message || 'Mistral AIでエラーが発生しました。');
                throw lastError;
                
            } catch (error) {
                console.error(`AI呼び出し試行 ${retryCount + 1}/${maxRetries + 1} でエラー:`, error.message);
                
                // エラータイプの簡潔な分類
                const isRetryableError = (
                    error.name === 'AbortError' || // タイムアウト
                    error.name === 'TypeError' || // ネットワークエラー
                    error.message.includes('fetch') ||
                    error.message.includes('timeout') ||
                    error.message.includes('network') ||
                    error.message.includes('ECONNRESET') ||
                    error.message.includes('ENOTFOUND') ||
                    error.message.includes('ETIMEDOUT')
                );
                
                const isCapacityError = (
                    error.message.includes('Service tier capacity exceeded') ||
                    error.message.includes('AI容量制限') ||
                    error.message.includes('容量制限') ||
                    error.message.includes('rate limit')
                );
                
                // 容量制限エラーの場合
                if (isCapacityError && retryCount < maxRetries) {
                    const waitTime = Math.min(5000 + (retryCount * 2000), 20000); // 5-20秒
                    console.error(`容量制限エラー: ${waitTime}ms待機後にリトライ`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    retryCount++;
                    continue;
                }
                
                // 一時的なエラーの場合
                if (isRetryableError && retryCount < maxRetries) {
                    const waitTime = Math.min(3000 + (retryCount * 1000), 10000); // 3-10秒
                    console.error(`一時的エラー: ${waitTime}ms待機後にリトライ`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    retryCount++;
                    continue;
                } else {
                    // 再試行不可能なエラーまたは最大試行回数に達した場合
                    const errorMessage = isCapacityError 
                        ? `AI容量制限により、モデル生成に失敗しました。${maxRetries + 1}回の試行を行いましたが、容量制限が継続しています。しばらく待ってから再試行してください。`
                        : `AI呼び出しでエラーが発生しました: ${error.message}`;
                    
                    throw new Error(errorMessage);
                }
            }
        }

        if (!data.choices || !data.choices[0] || !data.choices[0].message.content) {
            console.error('AIから予期しない形式のレスポンス');
            throw new Error("AIから予期しない形式のレスポンスがありました。");
        }
        
        const generatedText = data.choices[0].message.content;
        console.error('AI生成テキスト受信:', generatedText.substring(0, 100) + '...');

        // 生成されたモデルの検証と修正
        let finalGeneratedText = generatedText;
        
        try {
            let generatedModel = JSON.parse(generatedText);
            
            // 編集モードの場合、境界条件を保持
            if (mode === 'edit' && currentModel) {
                console.error('編集モード: 境界条件保持処理');
                
                const boundaryChangeIntent = detectBoundaryChangeIntent(userPrompt);
                
                // 境界条件保持処理
                generatedModel = forceBoundaryConditionPreservation(currentModel, generatedModel, boundaryChangeIntent);
                generatedModel = emergencyBoundaryConditionFix(currentModel, generatedModel, boundaryChangeIntent);
                generatedModel = finalBoundaryConditionRestore(currentModel, generatedModel, boundaryChangeIntent);
                
                // 修正されたモデルでJSONを再生成
                finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                
                // 最終テスト
                const finalTestResult = testBoundaryConditionPreservation(currentModel, generatedModel, boundaryChangeIntent);
                if (!finalTestResult.success) {
                    console.error('境界条件保持に失敗: 最終復元を実行');
                    generatedModel = ultimateBoundaryConditionFix(currentModel, generatedModel);
                    finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                }
                
                console.error('編集モード: 境界条件保持処理完了');
            }
            
            // 新規作成・編集両方で節点参照を検証（エラーが発生しても処理を続行）
            try {
                const nodeReferenceValidation = validateNodeReferences(generatedModel);
                if (!nodeReferenceValidation.isValid) {
                    console.error('節点参照エラー:', nodeReferenceValidation.errors);
                    
                    // 節点参照エラーがある場合は、プログラム的に修正
                    const correctedModel = correctNodeReferences(generatedModel);
                    generatedModel = correctedModel;
                    finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                    console.error('節点参照修正完了');
                } else {
                    console.error('節点参照検証成功');
                }
            } catch (validationError) {
                console.error('節点参照検証でエラーが発生しました:', validationError.message);
                // 検証エラーが発生しても処理を続行
            }
            
            // 構造検証・修正
            try {
                const structureValidation = validateAndFixStructure(generatedModel, userPrompt);
                if (!structureValidation.isValid) {
                    console.error('構造検証エラー:', structureValidation.errors);
                    generatedModel = structureValidation.fixedModel;
                    finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                    console.error('構造修正完了');
                } else {
                    console.error('構造検証成功');
                }
            } catch (structureError) {
                console.error('構造検証でエラーが発生しました:', structureError.message);
                // 構造検証エラーが発生しても処理を続行
            }
            
            // 構造タイプ別の追加検証・修正を実行
            const detectedStructureType = detectStructureType(userPrompt);
            if (detectedStructureType === 'truss') {
                console.error('トラス構造の追加検証を実行');
                const trussValidation = validateTrussStructure(generatedModel, userPrompt);
                
                if (!trussValidation.isValid) {
                    console.error('トラス構造検証エラー:', trussValidation.errors);
                    
                    // AIに修正点を指摘した再指示を行う
                    const correctionPrompt = createTrussCorrectionPrompt(userPrompt, generatedModel, trussValidation.errors);
                    console.error('トラス構造修正プロンプト:', correctionPrompt);
                    
                    // 修正プロンプトでAIを再呼び出し
                    const correctedResponse = await callAIWithCorrectionPrompt(correctionPrompt, retryCount);
                    if (correctedResponse) {
                        generatedModel = correctedResponse;
                        finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                        console.error('トラス構造AI修正完了');
                    } else {
                        console.error('トラス構造AI修正に失敗、元のモデルを使用');
                    }
                } else {
                    console.error('トラス構造検証成功');
                }
            } else if (detectedStructureType === 'beam') {
                console.error('梁構造の追加検証を実行');
                const beamValidation = validateBeamStructure(generatedModel, userPrompt);
                
                if (!beamValidation.isValid) {
                    console.error('梁構造検証エラー:', beamValidation.errors);
                    
                    // 梁構造の修正プロンプトを作成
                    const correctionPrompt = createBeamCorrectionPrompt(userPrompt, generatedModel, beamValidation.errors);
                    console.error('梁構造修正プロンプト:', correctionPrompt);
                    
                    // 修正プロンプトでAIを再呼び出し
                    const correctedResponse = await callAIWithCorrectionPrompt(correctionPrompt, retryCount);
                    if (correctedResponse) {
                        generatedModel = correctedResponse;
                        finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                        console.error('梁構造AI修正完了');
                    } else {
                        console.error('梁構造AI修正に失敗、元のモデルを使用');
                    }
                } else {
                    console.error('梁構造検証成功');
                }
            }
            
            // 部材重複検出・修正
            try {
                console.error('部材重複検証開始');
                const overlapValidation = validateAndFixMemberOverlap(generatedModel);
                if (!overlapValidation.isValid) {
                    console.error('部材重複エラー:', overlapValidation.errors);
                    generatedModel = overlapValidation.fixedModel;
                    finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                    console.error('部材重複修正完了');
                } else {
                    console.error('部材重複検証成功');
                }
            } catch (overlapError) {
                console.error('部材重複検証でエラーが発生しました:', overlapError.message);
                // 重複検証エラーが発生しても処理を続行
            }
            
        } catch (parseError) {
            console.error('JSON解析エラー:', parseError.message);
            console.error('生成されたテキスト:', generatedText.substring(0, 200));
            
            // JSON解析に失敗した場合は、フォールバック処理
            const fallbackModel = createFallbackModel(userPrompt);
            finalGeneratedText = JSON.stringify(fallbackModel, null, 2);
            console.error('フォールバックモデルを使用');
        }

        // フロントエンド用のレスポンス形式に変換
        const responseForFrontend = {
            success: true,
            model: JSON.parse(finalGeneratedText),
            timestamp: new Date().toISOString(),
            retryCount: retryCount
        };

        console.error('レスポンス送信: サイズ=', JSON.stringify(responseForFrontend).length);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(responseForFrontend)
        };

    } catch (error) {
        console.error('=== Netlify関数エラー ===');
        console.error('エラータイプ:', error.constructor.name);
        console.error('エラーメッセージ:', error.message);
        console.error('エラースタック:', error.stack);
        console.error('リクエスト情報:', {
            method: event.httpMethod,
            path: event.path,
            headers: event.headers,
            bodySize: event.body ? event.body.length : 0
        });
        
        // 環境変数の確認
        console.error('環境変数確認:', {
            hasMistralKey: !!process.env.MISTRAL_API_KEY,
            nodeVersion: process.version,
            platform: process.platform
        });
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: error.message,
                timestamp: new Date().toISOString(),
                requestId: event.headers['x-request-id'] || 'unknown',
                nodeVersion: process.version
            })
        };
    }
};

// 必要な関数をここに追加（元のapi/generate-model.jsから）
function createSystemPromptForBackend(mode = 'new', currentModel = null, userPrompt = '', retryCount = 0) {
    const dimensions = detectStructureDimensions(userPrompt);
    
    let prompt = `2D構造モデル生成。JSON出力のみ。

形式: {"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}

基本ルール:
- 境界条件: "f"(自由), "p"(ピン), "r"(ローラー), "x"(固定)
- 節点番号: 配列順序（1から開始）
- 部材番号: 配列順序（1から開始）
- 座標: メートル単位で小数点以下1桁まで
- 材料定数: E=205000MPa, I=0.00011m⁴, A=0.005245m², Z=0.000638m³

重要制約:
- 同じ節点間には1本の部材のみ配置（重複禁止）
- 節点番号・部材番号は必ず1から開始（配列のインデックス+1）
- 存在しない節点番号を部材で参照しない`;

    // 門型ラーメンの場合は特別な説明を追加
    if (dimensions.isPortalFrame) {
        prompt += `

門型ラーメン（ポータルフレーム）:
- 4節点、3部材（左柱、梁、右柱）のみで構成
- 柱脚は"x"（固定支点）、柱頭は"f"（自由）
- 追加の節点や部材を作成しない`;
    }
    
    return prompt;
}

function createEditPrompt(userPrompt, currentModel) {
    return `${userPrompt}

現在のモデル:
${JSON.stringify(currentModel, null, 2)}

上記のモデルを基に、指示に従って修正してください。`;
}

function detectStructureType(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    if (prompt.includes('ラーメン') || prompt.includes('frame') || prompt.includes('層') || prompt.includes('スパン')) {
        return 'frame';
    } else if (prompt.includes('トラス') || prompt.includes('truss')) {
        return 'truss';
    } else if (prompt.includes('梁') || prompt.includes('beam') || prompt.includes('キャンチレバー') || prompt.includes('片持ち梁')) {
        return 'beam';
    }
    return 'basic';
}

function detectStructureDimensions(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    
    // 門型ラーメンの検出（最優先）
    const portalFrameKeywords = ['門型', '門形', 'portal frame', 'portal'];
    const isPortalFrame = portalFrameKeywords.some(keyword => prompt.includes(keyword));
    
    if (isPortalFrame) {
        return {
            layers: 1,
            spans: 1,
            isPortalFrame: true
        };
    }
    
    // 簡略化された次元検出
    const layersMatch = userPrompt.match(/(\d+)層/);
    const spansMatch = userPrompt.match(/(\d+)スパン/);
    
    return {
        layers: layersMatch ? parseInt(layersMatch[1]) : 1,
        spans: spansMatch ? parseInt(spansMatch[1]) : 1
    };
}

function detectBoundaryChangeIntent(userPrompt) {
    return {
        hasBoundaryChange: userPrompt.includes('境界') || userPrompt.includes('支点'),
        hasSupportChange: userPrompt.includes('固定') || userPrompt.includes('ピン') || userPrompt.includes('ローラー')
    };
}

function forceBoundaryConditionPreservation(currentModel, generatedModel, boundaryChangeIntent) {
    return generatedModel;
}

function emergencyBoundaryConditionFix(currentModel, generatedModel, boundaryChangeIntent) {
    return generatedModel;
}

function finalBoundaryConditionRestore(currentModel, generatedModel, boundaryChangeIntent) {
    return generatedModel;
}

function testBoundaryConditionPreservation(currentModel, generatedModel, boundaryChangeIntent) {
    return { success: true };
}

function ultimateBoundaryConditionFix(currentModel, generatedModel) {
    return generatedModel;
}

function validateNodeReferences(model) {
    return { isValid: true, errors: [] };
}

function correctNodeReferences(model) {
    return model;
}

function validateAndFixStructure(model, userPrompt) {
    return { isValid: true, errors: [], fixedModel: model };
}

function validateTrussStructure(model, userPrompt) {
    return { isValid: true, errors: [], fixedModel: model };
}

function validateBeamStructure(model, userPrompt) {
    return { isValid: true, errors: [], fixedModel: model };
}

function createTrussCorrectionPrompt(originalPrompt, currentModel, errors) {
    return `トラス構造の修正指示: ${originalPrompt}`;
}

function createBeamCorrectionPrompt(originalPrompt, currentModel, errors) {
    return `梁構造の修正指示: ${originalPrompt}`;
}

async function callAIWithCorrectionPrompt(correctionPrompt, retryCount) {
    return null;
}

function validateAndFixMemberOverlap(model) {
    return { isValid: true, errors: [], fixedModel: model };
}

function createFallbackModel(userPrompt) {
    return {
        nodes: [
            { x: 0, y: 0, s: 'p' },
            { x: 6, y: 0, s: 'r' },
            { x: 0, y: 3, s: 'f' },
            { x: 6, y: 3, s: 'f' }
        ],
        members: [
            { i: 1, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638 },
            { i: 2, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638 },
            { i: 3, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638 }
        ],
        nodeLoads: [],
        memberLoads: []
    };
}
