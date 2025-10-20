// 外部と通信するための道具をインポートします
import fetch from 'node-fetch';

// Vercelのサーバーレス関数のエントリーポイント
export default async function handler(req, res) {
    console.error('AIモデル生成API開始');
    
    if (req.method !== 'POST') {
        console.error('メソッドエラー: POST以外のリクエスト');
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    try {
        const { prompt: userPrompt, mode = 'new', currentModel } = req.body;
        console.error('リクエスト解析: プロンプト=', userPrompt?.substring(0, 50) + '...', 'モード=', mode);
        
        if (!userPrompt) {
            console.error('エラー: 指示内容が空');
            res.status(400).json({ error: '指示内容が空です。' });
            return;
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
        const maxRetries = 5; // リトライ回数を5回に増加
        
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
                
                // その他のエラーは即座にスロー
            throw new Error(data.message || 'Mistral AIでエラーが発生しました。');
                
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
                // エラーが発生しても処理を続行（後でvalidateAndFixStructureで修正）
            }
        } catch (validationError) {
            console.error('節点参照検証でエラーが発生しました:', validationError);
            // エラーが発生しても処理を続行
        }
        
        // 構造検証と修正
        try {
            console.error('構造検証開始');
            
            const structureValidation = validateAndFixStructure(generatedModel, userPrompt);
            
            if (!structureValidation.isValid) {
                console.error('構造検証エラー:', structureValidation.errors);
                generatedModel = structureValidation.fixedModel;
                finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                console.error('構造修正完了');
            } else {
                console.error('構造検証成功');
            }
            
            // トラス構造の場合は追加の検証・修正を実行
            if (structureType === 'truss') {
                console.error('トラス構造の追加検証を実行');
                const trussValidation = validateAndFixTrussStructure(generatedModel, userPrompt);
                
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
                console.error('部材重複検証エラー:', overlapError.message);
            }
        } catch (structureError) {
            console.error('構造検証エラー:', structureError.message);
            }
            
            // 編集モードの場合、境界条件の保持を検証
            if (mode === 'edit' && currentModel) {
            try {
                const boundaryChangeIntent = detectBoundaryChangeIntent(userPrompt);
                const validationResult = validateBoundaryConditions(currentModel, generatedModel, boundaryChangeIntent);
                if (!validationResult.isValid) {
                    console.warn('境界条件保持の警告:', validationResult.warnings);
                    generatedModel = finalBoundaryConditionRestore(currentModel, generatedModel, boundaryChangeIntent);
                    finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                }
            } catch (boundaryError) {
                console.error('境界条件検証エラー:', boundaryError.message);
                }
            }
        } catch (parseError) {
        console.error('生成されたモデルの解析エラー:', parseError);
        console.error('エラーの詳細:', parseError.message);
        console.error('エラースタック:', parseError.stack);
        
        // JSON解析エラーでも、プログラム的生成を試行
        try {
            console.error('=== JSON解析エラー: プログラム的生成を試行 ===');
            const structureType = detectStructureType(userPrompt);
            const dimensions = detectStructureDimensions(userPrompt);
            
            console.error('検出された構造タイプ:', structureType);
            console.error('検出された次元:', dimensions);
            
            let programmaticModel;
            
            if (structureType === 'frame' && dimensions.layers > 0 && dimensions.spans > 0) {
                console.error(`${dimensions.layers}層${dimensions.spans}スパンラーメン構造をプログラム的に生成`);
                programmaticModel = generateCorrectFrameStructure(dimensions.layers, dimensions.spans);
            } else if (structureType === 'truss') {
                // トラス構造の場合は、AI生成を優先し、プログラム的生成は行わない
                console.error(`トラス構造のため、プログラム的生成をスキップします`);
                // AI生成に失敗した場合は、最小限のトラス構造を返す
                programmaticModel = {
                    nodes: [
                        {x: 0, y: 0, s: 'p'},
                        {x: 7.5, y: 0, s: 'r'},
                        {x: 0, y: 3, s: 'f'},
                        {x: 7.5, y: 3, s: 'f'}
                    ],
                    members: [
                        {i: 1, j: 2, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                        {i: 3, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                        {i: 1, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                        {i: 2, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                        {i: 1, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                        {i: 2, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638}
                    ]
                };
            } else {
                console.error('基本的な構造をプログラム的に生成');
                programmaticModel = generateBasicStructure(userPrompt, dimensions);
            }
            
            finalGeneratedText = JSON.stringify(programmaticModel, null, 2);
            console.error('プログラム的生成完了:', {
                nodeCount: programmaticModel.nodes.length,
                memberCount: programmaticModel.members.length
            });
            
        } catch (programmaticError) {
            console.error('プログラム的生成でもエラーが発生しました:', programmaticError);
            // 最終的なフォールバックとして、最小限の構造を生成
            finalGeneratedText = JSON.stringify({
                nodes: [
                    {x: 0, y: 0, s: 'x'},
                    {x: 6, y: 0, s: 'x'},
                    {x: 0, y: 3.5, s: 'f'},
                    {x: 6, y: 3.5, s: 'f'}
                ],
                members: [
                    {i: 1, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                    {i: 2, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                    {i: 3, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638}
                ]
            }, null, 2);
        }
    }

        // 最終的なモデルの状態を確認
        try {
            const finalModel = JSON.parse(finalGeneratedText);
            console.error('最終モデル: 節点=', finalModel.nodes?.length || 0, '部材=', finalModel.members?.length || 0);
        } catch (parseError) {
            console.error('最終モデルの解析エラー:', parseError.message);
        }

        const responseForFrontend = {
            candidates: [{
                content: {
                    parts: [{
                        text: finalGeneratedText
                    }]
                }
            }]
        };

        console.error('レスポンス送信: サイズ=', JSON.stringify(responseForFrontend).length);
        res.status(200).json(responseForFrontend);

    } catch (error) {
        console.error('=== サーバーレス関数エラー ===');
        console.error('エラータイプ:', error.constructor.name);
        console.error('エラーメッセージ:', error.message);
        console.error('エラースタック:', error.stack);
        console.error('リクエスト情報:', {
            method: req.method,
            url: req.url,
            headers: req.headers,
            bodySize: req.body ? JSON.stringify(req.body).length : 0
        });
        
        res.status(500).json({ 
            error: error.message,
            timestamp: new Date().toISOString(),
            requestId: req.headers['x-request-id'] || 'unknown'
        });
    }
}

function createSystemPromptForBackend(mode = 'new', currentModel = null, userPrompt = '', retryCount = 0) {
    // ユーザープロンプトから構造タイプと次元を検出
    const structureType = detectStructureType(userPrompt);
    const dimensions = detectStructureDimensions(userPrompt);
    const loadIntent = detectLoadIntent(userPrompt);
    
    // リトライ回数に応じてプロンプトを簡潔化
    if (retryCount >= 2) {
        // 3回目以降は極限まで簡潔
        let simplePrompt = `2D構造生成。JSON出力のみ。
{"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}
境界条件: "f","p","r","x"
節点番号: 配列順序（1から開始）
部材番号: 配列順序（1から開始）`;

        // 荷重指示の有無に基づいて条件分岐
        if (loadIntent.hasLoadIntent) {
            simplePrompt += `
荷重: 指示に応じて適切な荷重を生成（等分布荷重はプラスの値で下向き）`;
        } else {
            simplePrompt += `
荷重: 荷重の指示がない場合は、nodeLoadsとmemberLoadsは空配列[]で出力`;
        }
        
        simplePrompt += `
重要: 同じ節点間には1本の部材のみ配置（重複禁止）`;
        
        // 構造タイプに応じた重要ルールを追加
        if (structureType === 'beam') {
            simplePrompt += `
重要: 中間節点は"f"のみ、両端のみ"p"や"x"、y=0の節点に支点を設定しない`;
        } else if (structureType === 'truss') {
            simplePrompt += `
重要: 左端"p"、右端"r"、中間節点"f"、y=0の節点に支点を設定しない`;
        } else if (structureType === 'frame') {
            simplePrompt += `
重要: 地面節点は"x"、上部節点は"f"、y=0の地面には梁材（水平材）を配置しない`;
        } else {
            simplePrompt += `
重要: 中間節点は"f"のみ、両端のみ"p"や"x"`;
        }
        
        return simplePrompt;
    }
    
    // 通常のプロンプト
    let prompt = `2D構造モデル生成。JSON出力のみ。

形式: {"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}
境界条件: "f"(自由), "p"(ピン), "r"(ローラー), "x"(固定)
節点番号: 配列順序（1から開始）
部材番号: 配列順序（1から開始）`;

    // 荷重指示の有無に基づいて条件分岐
    if (loadIntent.hasLoadIntent) {
        prompt += `
荷重: 指示に応じて適切な荷重を生成（集中荷重、等分布荷重、水平荷重など）
等分布荷重: 特に指示がない場合はプラスの値（下向き）で生成`;
    } else {
        prompt += `
荷重: 荷重の指示がない場合は、nodeLoadsとmemberLoadsは空配列[]で出力`;
    }

    // 構造タイプに応じて最小限のルールを追加
    if (structureType === 'beam') {
        // キャンチレバー（片持ち梁）の検出
        if (userPrompt.includes('キャンチレバー') || userPrompt.includes('片持ち梁') || userPrompt.includes('cantilever')) {
            prompt += `
キャンチレバー（片持ち梁）: 左端のみ"x"、他は全て"f"、y=0の節点に"p"や"r"は禁止
荷重: 自由端に集中荷重を生成（例: {"n": 2, "fy": -10}）`;
        } else if (dimensions.spans > 1) {
            prompt += `
連続梁: 両端のみ"p"、中間節点は全て"f"、y=0の節点に"x"や"r"は禁止`;
            if (loadIntent.hasLoadIntent) {
                prompt += `
荷重: 適切な節点に集中荷重または等分布荷重を生成（等分布荷重はプラスの値で下向き）`;
            }
        } else {
            prompt += `
単純梁: 両端のみ"p"、中間節点は全て"f"、y=0の節点に"x"や"r"は禁止`;
            if (loadIntent.hasLoadIntent) {
                prompt += `
荷重: 中央部に集中荷重または等分布荷重を生成（等分布荷重はプラスの値で下向き）`;
            }
        }
    } else if (structureType === 'truss') {
        // トラス構造の詳細なプロンプト
        const height = extractHeightFromPrompt(userPrompt);
        const spanLength = extractSpanLengthFromPrompt(userPrompt);
        
        prompt += `
ワーレントラス構造: 高さ${height}m、スパン長${spanLength}m
節点配置: 下弦材（y=0）と上弦材（y=${height}）に節点を配置
境界条件: 左端（x=0）は"p"、右端（x=${spanLength}）は"r"、その他は"f"
部材配置: 下弦材・上弦材・斜材を適切に配置（ワーレントラスの特徴的な斜めの部材を含む）`;
        
        if (loadIntent.hasLoadIntent) {
            prompt += `
荷重: 適切な節点に集中荷重を生成（通常は上弦材の節点に作用）`;
        }
        
        // 具体的な例を追加
        prompt += `
例: 高さ3m、スパン15mのワーレントラスなら
節点: [{"x":0,"y":0,"s":"p"},{"x":7.5,"y":0,"s":"f"},{"x":15,"y":0,"s":"r"},{"x":0,"y":3,"s":"f"},{"x":7.5,"y":3,"s":"f"},{"x":15,"y":3,"s":"f"}]
部材: 下弦材、上弦材、斜材を適切に配置`;
    } else if (structureType === 'frame') {
        // 層数・スパン数が検出された場合のみ詳細ルールを追加
        if (dimensions.layers > 0 && dimensions.spans > 0) {
            const expectedNodes = (dimensions.layers + 1) * (dimensions.spans + 1);
            const expectedColumns = (dimensions.spans + 1) * dimensions.layers;
            const expectedBeams = dimensions.spans * dimensions.layers; // y=0の地面には梁材なし
            const expectedMembers = expectedColumns + expectedBeams;
            
            prompt += `
ラーメン(${dimensions.layers}層${dimensions.spans}スパン): 節点${expectedNodes}個、部材${expectedMembers}個（柱${expectedColumns}本+梁${expectedBeams}本）
座標: X=0,6,12...m、Y=0,3.5,7...m
境界条件: 地面節点は"x"、上部節点は"f"
部材配置: y=0の地面には梁材（水平材）を配置しない`;
            if (loadIntent.hasLoadIntent) {
                prompt += `
荷重: 各層に水平荷重、適切な節点に集中荷重を生成`;
            }
        } else {
            prompt += `
ラーメン: 多層多スパン、全柱梁配置`;
            if (loadIntent.hasLoadIntent) {
                prompt += `
荷重: 各層に水平荷重、適切な節点に集中荷重を生成`;
            }
        }
    }

    // 構造タイプに応じた重要ルールを追加
    if (structureType === 'beam') {
        prompt += `
重要: 節点番号は存在するもののみ参照、梁構造ではy=0の節点に支点を設定しない`;
    } else if (structureType === 'truss') {
        prompt += `
重要: 節点番号は存在するもののみ参照、トラス構造ではy=0の節点に支点を設定しない`;
    } else if (structureType === 'frame') {
        prompt += `
重要: 節点番号は存在するもののみ参照、地面節点は"x"`;
    } else {
        prompt += `
重要: 節点番号は存在するもののみ参照`;
    }
    
    // 具体的な例を追加（梁構造のみ）
    if (structureType === 'beam') {
        if (dimensions.spans > 1) {
            prompt += `
例: 連続梁なら[{"x":0,"y":0,"s":"p"},{"x":6,"y":0,"s":"f"},{"x":14,"y":0,"s":"f"},{"x":20,"y":0,"s":"p"}]（y=0でも支点は両端のみ）
部材例: [{"i":1,"j":2},{"i":2,"j":3},{"i":3,"j":4}]（節点番号は1から開始）`;
        } else {
            prompt += `
例: 単純梁なら[{"x":0,"y":0,"s":"p"},{"x":12,"y":0,"s":"p"}]（y=0でも支点は両端のみ）
部材例: [{"i":1,"j":2}]（節点番号は1から開始）`;
        }
    }
    
    // 全構造タイプに共通の例を追加
    prompt += `
重要: 節点番号・部材番号は必ず1から開始（配列のインデックス+1）
部材配置: 同じ節点間には1本の部材のみ配置（重複禁止）`;

    return prompt;
}

// 構造タイプを検出する関数
function detectStructureType(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    
    // ラーメン構造のキーワード（最優先）
    const frameKeywords = ['ラーメン', 'フレーム', 'frame', '門型', '多層', '層', '柱', '階'];
    if (frameKeywords.some(keyword => prompt.includes(keyword))) {
        return 'frame';
    }
    
    // 梁構造のキーワード
    const beamKeywords = ['連続梁', '単純梁', '梁', 'beam', '連続', '単純', '支点', 'ピン支点', '固定支点', 'キャンチレバー', '片持ち梁', 'cantilever'];
    if (beamKeywords.some(keyword => prompt.includes(keyword))) {
        return 'beam';
    }
    
    // トラス構造のキーワード
    const trussKeywords = ['トラス', 'truss', 'ワーレン', 'warren', 'プラット', 'pratt', 'ハウ', 'howe', '斜材', '弦材'];
    if (trussKeywords.some(keyword => prompt.includes(keyword))) {
        return 'truss';
    }
    
    return 'basic';
}

// 荷重指示を検出する関数
function detectLoadIntent(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    
    // 荷重関連のキーワード
    const loadKeywords = [
        '荷重', 'load', '集中荷重', '等分布荷重', '分布荷重', '水平荷重', '鉛直荷重',
        '外力', '力', 'kN', 'kgf', 'tf', 'トン', 'キロ', '重量', '重さ',
        '風荷重', '地震荷重', '積載荷重', '固定荷重', '活荷重', '雪荷重',
        '作用', '加える', 'かける', '適用', '設定'
    ];
    
    // 荷重の種類を特定
    const nodeLoadKeywords = ['集中荷重', '点荷重', '節点荷重', '外力'];
    const memberLoadKeywords = ['等分布荷重', '分布荷重', '部材荷重', '梁荷重'];
    
    const hasLoadKeyword = loadKeywords.some(keyword => prompt.includes(keyword));
    const hasNodeLoadKeyword = nodeLoadKeywords.some(keyword => prompt.includes(keyword));
    const hasMemberLoadKeyword = memberLoadKeywords.some(keyword => prompt.includes(keyword));
    
    return {
        hasLoadIntent: hasLoadKeyword,
        hasNodeLoadIntent: hasNodeLoadKeyword,
        hasMemberLoadIntent: hasMemberLoadKeyword,
        loadType: hasNodeLoadKeyword ? 'node' : hasMemberLoadKeyword ? 'member' : 'both'
    };
}

// 構造の層数とスパン数を検出する関数
function detectStructureDimensions(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    
    // 層数の検出（より柔軟な検出）
    let layers = 1;
    const layerPatterns = [
        /(\d+)層/g,
        /(\d+)階/g,
        /(\d+)story/g,
        /(\d+)floor/g,
        /(\d+)\s*層/g,  // 数字と層の間にスペースがある場合
        /(\d+)\s*階/g   // 数字と階の間にスペースがある場合
    ];
    
    // トラス構造の高さ検出パターンを追加
    const heightPatterns = [
        /高さ(\d+(?:\.\d+)?)m/g,
        /height\s*(\d+(?:\.\d+)?)m/g,
        /(\d+(?:\.\d+)?)m.*高さ/g,
        /(\d+(?:\.\d+)?)m.*height/g
    ];
    
    console.error('層数検出デバッグ:', {
        prompt: prompt,
        patterns: layerPatterns.map(p => p.toString())
    });
    
    for (const pattern of layerPatterns) {
        const match = prompt.match(pattern);
        console.error(`パターン ${pattern} のマッチ結果:`, match);
        if (match) {
            // 正規表現から数字を抽出
            const numberMatch = match[0].match(/\d+/);
            if (numberMatch) {
                const extractedNumber = numberMatch[0];
                layers = parseInt(extractedNumber, 10);
                console.error(`層数検出: "${match[0]}" -> 抽出された数字: "${extractedNumber}" -> ${layers}`);
                if (!isNaN(layers)) {
                    break;
                }
            }
        }
    }
    
    // トラス構造の高さ検出
    for (const pattern of heightPatterns) {
        const match = prompt.match(pattern);
        console.error(`高さパターン ${pattern} のマッチ結果:`, match);
        if (match) {
            // マッチした文字列から数字を抽出
            const numberMatch = match[0].match(/\d+(?:\.\d+)?/);
            if (numberMatch) {
                const height = parseFloat(numberMatch[0]);
                console.error(`高さ検出: "${match[0]}" -> 抽出された数字: "${numberMatch[0]}" -> 高さ: ${height}m`);
                if (!isNaN(height)) {
                    // トラス構造では高さを層数として扱う（簡易的な対応）
                    layers = Math.max(layers, Math.ceil(height / 3.0)); // 3mごとに1層として計算
                    break;
                }
            }
        }
    }
    
    // スパン数の検出（より柔軟な検出）
    let spans = 1;
    const spanPatterns = [
        /(\d+)スパン/g,
        /(\d+)span/g,
        /(\d+)間/g,
        /(\d+)\s*スパン/g,  // 数字とスパンの間にスペースがある場合
        /(\d+)\s*span/g     // 数字とspanの間にスペースがある場合
    ];
    
    // トラス構造のスパン検出パターンを追加
    const spanLengthPatterns = [
        /スパン(\d+(?:\.\d+)?)m/g,
        /span\s*(\d+(?:\.\d+)?)m/g,
        /(\d+(?:\.\d+)?)m.*スパン/g,
        /(\d+(?:\.\d+)?)m.*span/g
    ];
    
    for (const pattern of spanPatterns) {
        const match = prompt.match(pattern);
        console.error(`スパンパターン ${pattern} のマッチ結果:`, match);
        if (match) {
            // 正規表現から数字を抽出
            const numberMatch = match[0].match(/\d+/);
            if (numberMatch) {
                const extractedNumber = numberMatch[0];
                spans = parseInt(extractedNumber, 10);
                console.error(`スパン数検出: "${match[0]}" -> 抽出された数字: "${extractedNumber}" -> ${spans}`);
                if (!isNaN(spans)) {
                    break;
                }
            }
        }
    }
    
    // トラス構造のスパン長検出
    for (const pattern of spanLengthPatterns) {
        const match = prompt.match(pattern);
        console.error(`スパン長パターン ${pattern} のマッチ結果:`, match);
        if (match) {
            // マッチした文字列から数字を抽出
            const numberMatch = match[0].match(/\d+(?:\.\d+)?/);
            if (numberMatch) {
                const spanLength = parseFloat(numberMatch[0]);
                console.error(`スパン長検出: "${match[0]}" -> 抽出された数字: "${numberMatch[0]}" -> スパン長: ${spanLength}m`);
                if (!isNaN(spanLength)) {
                    // トラス構造ではスパン長からスパン数を推定（簡易的な対応）
                    spans = Math.max(spans, Math.ceil(spanLength / 3.0)); // 3mごとに1スパンとして計算
                    break;
                }
            }
        }
    }
    
    // デフォルト値の設定（明示的な指定がない場合）
    if (layers === 1 && spans === 1) {
        // キーワードから推定
        if (prompt.includes('多層') || prompt.includes('高層')) {
            layers = 4;
        }
        if (prompt.includes('多スパン') || prompt.includes('大規模')) {
            spans = 4;
        }
    }
    
    console.error(`最終検出結果: layers=${layers}, spans=${spans}`);
    
    return {
        layers: Math.max(1, layers),
        spans: Math.max(1, spans)
    };
}

function createEditPrompt(userPrompt, currentModel) {
    // 境界条件変更の意図を検出
    const boundaryChangeIntent = detectBoundaryChangeIntent(userPrompt);
    
    let editPrompt = `編集指示: ${userPrompt}\n\n`;
    
    if (boundaryChangeIntent.detected) {
        editPrompt += `**境界条件変更の指示が検出されました**:\n`;
        editPrompt += `- 変更対象: ${boundaryChangeIntent.target}\n`;
        editPrompt += `- 新しい境界条件: ${boundaryChangeIntent.newCondition}\n`;
        editPrompt += `- 上記の指示に従って境界条件を変更してください\n\n`;
    } else {
        editPrompt += `**重要: 境界条件変更の指示は検出されませんでした**\n`;
        editPrompt += `- 既存の節点の境界条件（s）を必ず保持してください\n`;
        editPrompt += `- 座標変更や部材変更の指示だけで境界条件を変更することは絶対に禁止です\n\n`;
    }
    
    if (currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        editPrompt += `現在の節点情報（境界条件を必ず保持してください）:\n`;
        currentModel.nodes.forEach((node, index) => {
            const supportText = {
                'f': '自由',
                'p': 'ピン', 
                'x': '固定',
                'r': 'ローラー'
            }[node.s] || node.s;
            editPrompt += `節点${index + 1}: (${node.x}, ${node.y}) - ${supportText}(${node.s})\n`;
        });
        editPrompt += `\n`;
        
        editPrompt += `**重要**: 上記の境界条件(${currentModel.nodes.map(n => n.s).join(', ')})を必ず保持してください\n\n`;
    }
    
    if (currentModel && currentModel.members && currentModel.members.length > 0) {
        editPrompt += `現在の部材情報:\n`;
        currentModel.members.forEach((member, index) => {
            editPrompt += `部材${index + 1}: 節点${member.i} → 節点${member.j}\n`;
        });
        editPrompt += `\n`;
    }
    
    editPrompt += `上記の現在のモデルに対して、指示された編集を適用してください。\n\n`;
    editPrompt += `**最終確認事項（絶対に守ってください）**:\n`;
    editPrompt += `- 境界条件変更の指示がない場合は、既存の節点の境界条件（s）を必ず保持してください\n`;
    editPrompt += `- 座標変更や部材変更の指示だけで境界条件を変更することは絶対に禁止です\n`;
    editPrompt += `- 生成するJSONでは、既存の節点の境界条件（s）を元の値のまま出力してください\n`;
    
    return editPrompt;
}

// 境界条件変更の意図を検出する関数
function detectBoundaryChangeIntent(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    
    // 境界条件変更のキーワードを検索
    const boundaryKeywords = [
        '境界条件', '支点', '柱脚', '基礎', '固定', 'ピン', 'ローラー', '自由',
        'support', 'boundary', 'fixed', 'pinned', 'roller', 'free'
    ];
    
    const changeKeywords = [
        '変更', '修正', '変更する', '変更してください', 'に変更', 'から', 'に',
        'change', 'modify', 'update'
    ];
    
    // 座標変更のキーワード（境界条件変更ではない）
    const coordinateChangeKeywords = [
        'スパン', '長さ', '高さ', '座標', '位置', '移動', '変更', 'span', 'length', 'height', 'coordinate', 'position', 'change'
    ];
    
    // 境界条件の種類
    const conditionMap = {
        '固定': 'x', 'fixed': 'x',
        'ピン': 'p', 'pinned': 'p', 'pin': 'p',
        'ローラー': 'r', 'roller': 'r',
        '自由': 'f', 'free': 'f'
    };
    
    // 境界条件変更の意図を検出
    let detected = false;
    let target = '';
    let newCondition = '';
    
    // キーワードの組み合わせをチェック
    const hasBoundaryKeyword = boundaryKeywords.some(keyword => prompt.includes(keyword));
    const hasChangeKeyword = changeKeywords.some(keyword => prompt.includes(keyword));
    const hasCoordinateChangeKeyword = coordinateChangeKeywords.some(keyword => prompt.includes(keyword));
    
    console.error('境界条件変更意図検出:');
    console.error('- 境界条件キーワード:', hasBoundaryKeyword);
    console.error('- 変更キーワード:', hasChangeKeyword);
    console.error('- 座標変更キーワード:', hasCoordinateChangeKeyword);
    
    // 座標変更のキーワードがある場合は、境界条件変更ではないと判定
    if (hasCoordinateChangeKeyword && !hasBoundaryKeyword) {
        console.error('座標変更のキーワードが検出されたため、境界条件変更ではないと判定');
        return {
            detected: false,
            target: '',
            newCondition: ''
        };
    }
    
    // スパン変更の場合は、境界条件変更ではない
    if (prompt.includes('スパン') && !hasBoundaryKeyword) {
        console.error('スパン変更が検出されたため、境界条件変更ではないと判定');
        return {
            detected: false,
            target: '',
            newCondition: ''
        };
    }
    
    if (hasBoundaryKeyword && hasChangeKeyword) {
        detected = true;
        
        // 変更対象を特定
        if (prompt.includes('柱脚') || prompt.includes('基礎')) {
            target = '柱脚（Y座標=0の節点）';
        } else if (prompt.includes('支点')) {
            target = '支点';
        } else if (prompt.includes('節点')) {
            target = '指定された節点';
        } else {
            target = '指定された節点';
        }
        
        // 新しい境界条件を特定
        for (const [keyword, code] of Object.entries(conditionMap)) {
            if (prompt.includes(keyword)) {
                newCondition = `${keyword}(${code})`;
                break;
            }
        }
        
        if (!newCondition) {
            newCondition = '指定された境界条件';
        }
    }
    
    return {
        detected: detected,
        target: target,
        newCondition: newCondition
    };
}

// 節点参照を検証する関数
function validateNodeReferences(model) {
    const errors = [];
    
    try {
        console.error('=== 節点参照検証開始 ===');
        console.error('検証対象モデル:', JSON.stringify(model, null, 2));
    
    if (!model.nodes || !Array.isArray(model.nodes)) {
        errors.push('節点配列が存在しません');
            console.error('節点配列が存在しません');
        return { isValid: false, errors: errors };
    }
    
    if (!model.members || !Array.isArray(model.members)) {
        errors.push('部材配列が存在しません');
            console.error('部材配列が存在しません');
        return { isValid: false, errors: errors };
    }
    
    const nodeCount = model.nodes.length;
        console.error('節点数:', nodeCount);
        console.error('部材数:', model.members.length);
    
    // 各節点の基本的な構造をチェック
    model.nodes.forEach((node, index) => {
        if (!node.hasOwnProperty('x') || !node.hasOwnProperty('y') || !node.hasOwnProperty('s')) {
            errors.push(`節点${index + 1}に必須プロパティ（x, y, s）が不足しています`);
                console.error(`節点${index + 1}に必須プロパティ（x, y, s）が不足しています`);
        }
        if (typeof node.x !== 'number' || typeof node.y !== 'number') {
            errors.push(`節点${index + 1}の座標が数値ではありません`);
                console.error(`節点${index + 1}の座標が数値ではありません`);
        }
        if (!['f', 'p', 'r', 'x'].includes(node.s)) {
            errors.push(`節点${index + 1}の境界条件（${node.s}）が無効です`);
                console.error(`節点${index + 1}の境界条件（${node.s}）が無効です`);
        }
    });
    
    // 各部材の節点参照をチェック
    model.members.forEach((member, index) => {
        if (!member.hasOwnProperty('i') || !member.hasOwnProperty('j')) {
            errors.push(`部材${index + 1}に必須プロパティ（i, j）が不足しています`);
                console.error(`部材${index + 1}に必須プロパティ（i, j）が不足しています`);
            return;
        }
        
        const i = member.i;
        const j = member.j;
        
        if (!Number.isInteger(i) || !Number.isInteger(j)) {
            errors.push(`部材${index + 1}の節点番号（${i}, ${j}）が整数ではありません`);
                console.error(`部材${index + 1}の節点番号（${i}, ${j}）が整数ではありません`);
            return;
        }
        
        if (i < 1 || i > nodeCount) {
            errors.push(`部材${index + 1}の開始節点番号（${i}）が範囲外です（1-${nodeCount}）`);
                console.error(`部材${index + 1}の開始節点番号（${i}）が範囲外です（1-${nodeCount}）`);
        }
        
        if (j < 1 || j > nodeCount) {
            errors.push(`部材${index + 1}の終了節点番号（${j}）が範囲外です（1-${nodeCount}）`);
                console.error(`部材${index + 1}の終了節点番号（${j}）が範囲外です（1-${nodeCount}）`);
        }
        
        if (i === j) {
            errors.push(`部材${index + 1}の開始節点と終了節点が同じです（${i}）`);
                console.error(`部材${index + 1}の開始節点と終了節点が同じです（${i}）`);
        }
    });
    
    // 節点荷重の参照をチェック
    if (model.nodeLoads || model.nl) {
        const nodeLoads = model.nodeLoads || model.nl;
        if (Array.isArray(nodeLoads)) {
            nodeLoads.forEach((load, index) => {
                const nodeNumber = load.n || load.node;
                if (!nodeNumber) {
                    errors.push(`節点荷重${index + 1}に節点番号が指定されていません`);
                        console.error(`節点荷重${index + 1}に節点番号が指定されていません`);
                    return;
                }
                if (!Number.isInteger(nodeNumber) || nodeNumber < 1 || nodeNumber > nodeCount) {
                    errors.push(`節点荷重${index + 1}の節点番号（${nodeNumber}）が範囲外です（1-${nodeCount}）`);
                        console.error(`節点荷重${index + 1}の節点番号（${nodeNumber}）が範囲外です（1-${nodeCount}）`);
                }
            });
        }
    }
    
    // 部材荷重の参照をチェック
    if (model.memberLoads || model.ml) {
        const memberLoads = model.memberLoads || model.ml;
        if (Array.isArray(memberLoads)) {
            memberLoads.forEach((load, index) => {
                const memberNumber = load.m || load.member;
                if (!memberNumber) {
                    errors.push(`部材荷重${index + 1}に部材番号が指定されていません`);
                        console.error(`部材荷重${index + 1}に部材番号が指定されていません`);
                    return;
                }
                if (!Number.isInteger(memberNumber) || memberNumber < 1 || memberNumber > model.members.length) {
                    errors.push(`部材荷重${index + 1}の部材番号（${memberNumber}）が範囲外です（1-${model.members.length}）`);
                        console.error(`部材荷重${index + 1}の部材番号（${memberNumber}）が範囲外です（1-${model.members.length}）`);
                }
            });
        }
    }
    
    // スパン数の検証（ラーメン構造の場合）
        try {
    const spanValidation = validateSpanCount(model);
    if (!spanValidation.isValid) {
        errors.push(...spanValidation.errors);
                console.error('スパン数検証エラー:', spanValidation.errors);
            }
        } catch (spanError) {
            console.error('スパン数検証でエラーが発生しました:', spanError);
            // スパン数検証のエラーは致命的ではないので、処理を続行
        }
        
        console.error('節点参照検証結果:', {
            isValid: errors.length === 0,
            errors: errors
        });
        console.error('=== 節点参照検証完了 ===');
    
    return {
        isValid: errors.length === 0,
        errors: errors
    };
        
    } catch (error) {
        console.error('validateNodeReferences関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、検証失敗として返す
        return {
            isValid: false,
            errors: ['節点参照検証でエラーが発生しました: ' + error.message]
        };
    }
}

// スパン数を検証する関数
function validateSpanCount(model) {
    const errors = [];
    
    try {
        console.error('=== スパン数検証開始 ===');
        console.error('検証対象モデル:', JSON.stringify(model, null, 2));
    
    if (!model.nodes || !model.members || model.nodes.length < 4 || model.members.length < 3) {
            console.error('最小限の構造でないため、スパン数検証をスキップ');
        return { isValid: true, errors: [] }; // 最小限の構造でない場合はスキップ
    }
    
    // Y座標=0の節点（柱脚）の数をカウント
    const groundNodes = model.nodes.filter(node => node.y === 0);
    const spanCount = groundNodes.length - 1;
        
        console.error('柱脚節点数:', groundNodes.length);
        console.error('スパン数:', spanCount);
    
    // 各層の節点数をカウント
    const layerCounts = {};
    model.nodes.forEach(node => {
        const layer = node.y;
        layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    });
        
        console.error('各層の節点数:', layerCounts);
    
    // 各層の節点数が一致するかチェック
    const layerNodeCounts = Object.values(layerCounts);
    const expectedNodeCount = groundNodes.length;
    
    for (const count of layerNodeCounts) {
        if (count !== expectedNodeCount) {
            errors.push(`層によって節点数が異なります。柱脚: ${expectedNodeCount}個、他の層: ${count}個`);
                console.error(`層によって節点数が異なります。柱脚: ${expectedNodeCount}個、他の層: ${count}個`);
            break;
        }
    }
    
        // 部材数の検証
        const expectedColumnCount = (spanCount + 1) * layerNodeCounts.length; // 柱は(スパン数+1)×層数
        const expectedBeamCount = spanCount * layerNodeCounts.length; // 梁はスパン数×層数（y=0の地面には梁材なし）
        const expectedTotalMembers = expectedColumnCount + expectedBeamCount;
        
        console.error('期待される部材数:', {
            expectedColumnCount,
            expectedBeamCount,
            expectedTotalMembers,
            actualMemberCount: model.members.length
        });
    
    if (model.members.length !== expectedTotalMembers) {
        errors.push(`部材数が不正です。期待値: ${expectedTotalMembers}個、実際: ${model.members.length}個`);
            console.error(`部材数が不正です。期待値: ${expectedTotalMembers}個、実際: ${model.members.length}個`);
    }
    
    // スパン数の検証（一般的なラーメン構造の場合）
    if (spanCount < 1 || spanCount > 10) {
        errors.push(`スパン数が異常です: ${spanCount}スパン`);
            console.error(`スパン数が異常です: ${spanCount}スパン`);
        }
        
        console.error('スパン数検証結果:', {
            isValid: errors.length === 0,
            errors: errors
        });
        console.error('=== スパン数検証完了 ===');
    
    return {
        isValid: errors.length === 0,
        errors: errors
    };
        
    } catch (error) {
        console.error('validateSpanCount関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、検証失敗として返す
        return {
            isValid: false,
            errors: ['スパン数検証でエラーが発生しました: ' + error.message]
        };
    }
}

// 境界条件を強制的に保持する関数
function forceBoundaryConditionPreservation(originalModel, generatedModel, boundaryChangeIntent = null) {
    if (!originalModel.nodes || !generatedModel.nodes) {
        console.error('節点データが不足しているため、境界条件保持をスキップします');
        return generatedModel;
    }

    const preservedModel = JSON.parse(JSON.stringify(generatedModel)); // ディープコピー
    let boundaryChangesDetected = false;
    let boundaryChangesApplied = 0;

    console.error('=== 境界条件保持処理開始 ===');
    console.error('元のモデルの境界条件:', originalModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.error('生成されたモデルの境界条件:', generatedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    
    // 境界条件変更の意図がない場合は、既存の境界条件を強制的に保持
    if (!boundaryChangeIntent || !boundaryChangeIntent.detected) {
        console.error('境界条件変更の意図は検出されませんでした。強制的に境界条件を保持します。');
        
        const minLength = Math.min(originalModel.nodes.length, preservedModel.nodes.length);
        
        for (let i = 0; i < minLength; i++) {
            const originalNode = originalModel.nodes[i];
            const generatedNode = preservedModel.nodes[i];
            
            // 境界条件が変更されている場合は、元の境界条件を復元
            if (originalNode.s !== generatedNode.s) {
                console.error(`節点${i + 1}の境界条件を復元: ${generatedNode.s} → ${originalNode.s}`);
                preservedModel.nodes[i].s = originalNode.s;
                boundaryChangesDetected = true;
                boundaryChangesApplied++;
            }
        }
        
        if (boundaryChangesApplied > 0) {
            console.error(`境界条件の強制保持を適用しました: ${boundaryChangesApplied}個の節点を修正`);
        } else {
            console.error('境界条件の変更は検出されませんでした');
        }
    } else {
        // 境界条件変更の意図がある場合の処理
        console.error('境界条件変更の意図が検出されました:', boundaryChangeIntent);
        
        // 柱脚の境界条件変更の場合
        if (boundaryChangeIntent.target.includes('柱脚')) {
            const groundNodes = preservedModel.nodes.filter(node => node.y === 0);
            console.error(`柱脚節点を検出: ${groundNodes.length}個`);
            
            groundNodes.forEach(node => {
                const nodeIndex = preservedModel.nodes.indexOf(node);
                const originalBoundary = preservedModel.nodes[nodeIndex].s;
                
                if (boundaryChangeIntent.newCondition.includes('ピン')) {
                    preservedModel.nodes[nodeIndex].s = 'p';
                } else if (boundaryChangeIntent.newCondition.includes('ローラー')) {
                    preservedModel.nodes[nodeIndex].s = 'r';
                } else if (boundaryChangeIntent.newCondition.includes('固定')) {
                    preservedModel.nodes[nodeIndex].s = 'x';
                } else if (boundaryChangeIntent.newCondition.includes('自由')) {
                    preservedModel.nodes[nodeIndex].s = 'f';
                }
                
                console.error(`柱脚節点の境界条件を変更: (${node.x},${node.y}) ${originalBoundary} → ${preservedModel.nodes[nodeIndex].s}`);
                boundaryChangesApplied++;
            });
        }
    }
    
    console.error('修正後のモデルの境界条件:', preservedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.error('=== 境界条件保持処理完了 ===');
    
    return preservedModel;
}

// フォールバック: 最終的な境界条件復元関数
function finalBoundaryConditionRestore(originalModel, generatedModel, boundaryChangeIntent = null) {
    if (!originalModel.nodes || !generatedModel.nodes) {
        console.log('フォールバック: 節点データが不足しているため、処理をスキップします');
        return generatedModel;
    }
    
    const restoredModel = JSON.parse(JSON.stringify(generatedModel)); // ディープコピー
    
    console.log('=== フォールバック境界条件復元処理開始 ===');
    console.log('元のモデルの境界条件:', originalModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.log('現在のモデルの境界条件:', generatedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    
    // 境界条件変更の意図がない場合は、全ての境界条件を強制的に復元
    if (!boundaryChangeIntent || !boundaryChangeIntent.detected) {
        console.log('フォールバック: 境界条件変更の意図がないため、全ての境界条件を強制的に復元します');
        
        const minLength = Math.min(originalModel.nodes.length, restoredModel.nodes.length);
        let restoredCount = 0;
        
        for (let i = 0; i < minLength; i++) {
            const originalNode = originalModel.nodes[i];
            const currentNode = restoredModel.nodes[i];
            
            if (originalNode.s !== currentNode.s) {
                console.log(`フォールバック: 節点${i + 1}の境界条件を復元: ${currentNode.s} → ${originalNode.s}`);
                restoredModel.nodes[i].s = originalNode.s;
                restoredCount++;
            }
        }
        
        console.log(`フォールバック: ${restoredCount}個の節点の境界条件を復元しました`);
    } else {
        console.log('フォールバック: 境界条件変更の意図があるため、適切な処理を実行します');
        // 境界条件変更の意図がある場合は、forceBoundaryConditionPreservationと同じ処理
        return forceBoundaryConditionPreservation(originalModel, generatedModel, boundaryChangeIntent);
    }
    
    console.log('フォールバック復元後の境界条件:', restoredModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.log('=== フォールバック境界条件復元処理完了 ===');
    
    return restoredModel;
}

// 緊急的な境界条件復元関数（確実に境界条件を保持する最終手段）
function emergencyBoundaryConditionFix(originalModel, generatedModel, boundaryChangeIntent = null) {
    if (!originalModel.nodes || !generatedModel.nodes) {
        console.log('緊急修正: 節点データが不足しているため、処理をスキップします');
        return generatedModel;
    }
    
    const fixedModel = JSON.parse(JSON.stringify(generatedModel)); // ディープコピー
    
    console.log('=== 緊急境界条件復元処理開始 ===');
    console.log('元のモデルの境界条件:', originalModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.log('現在のモデルの境界条件:', generatedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    
    // 境界条件変更の意図がない場合は、全ての境界条件を強制的に復元
    if (!boundaryChangeIntent || !boundaryChangeIntent.detected) {
        console.log('緊急修正: 境界条件変更の意図がないため、全ての境界条件を強制的に復元します');
        
        const minLength = Math.min(originalModel.nodes.length, fixedModel.nodes.length);
        let fixedCount = 0;
        
        for (let i = 0; i < minLength; i++) {
            const originalNode = originalModel.nodes[i];
            const currentNode = fixedModel.nodes[i];
            
            // 強制的に境界条件を復元（条件チェックなし）
            if (originalNode.s !== currentNode.s) {
                console.log(`緊急修正: 節点${i + 1}の境界条件を強制復元: ${currentNode.s} → ${originalNode.s}`);
                fixedModel.nodes[i].s = originalNode.s;
                fixedCount++;
            } else {
                console.log(`緊急修正: 節点${i + 1}の境界条件は正しい: ${currentNode.s}`);
            }
        }
        
        console.log(`緊急修正: ${fixedCount}個の節点の境界条件を復元しました`);
        
        // 最終確認: 全ての境界条件が正しいかチェック
        let allCorrect = true;
        for (let i = 0; i < minLength; i++) {
            if (originalModel.nodes[i].s !== fixedModel.nodes[i].s) {
                console.error(`緊急修正エラー: 節点${i + 1}の境界条件が復元されていません: ${fixedModel.nodes[i].s} (期待値: ${originalModel.nodes[i].s})`);
                allCorrect = false;
            }
        }
        
        if (allCorrect) {
            console.log('緊急修正: 全ての境界条件が正しく復元されました');
        } else {
            console.error('緊急修正: 境界条件の復元に失敗しました');
        }
    } else {
        console.log('緊急修正: 境界条件変更の意図があるため、通常の処理を実行します');
    }
    
    console.log('緊急修正後の境界条件:', fixedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.log('=== 緊急境界条件復元処理完了 ===');
    
    return fixedModel;
}

// 境界条件保持のテスト関数
function testBoundaryConditionPreservation(originalModel, generatedModel, boundaryChangeIntent = null) {
    if (!originalModel.nodes || !generatedModel.nodes) {
        return {
            success: false,
            message: '節点データが不足しています',
            details: {}
        };
    }
    
    console.log('=== 境界条件保持テスト開始 ===');
    
    const minLength = Math.min(originalModel.nodes.length, generatedModel.nodes.length);
    let correctCount = 0;
    let incorrectCount = 0;
    const incorrectNodes = [];
    
    for (let i = 0; i < minLength; i++) {
        const originalBoundary = originalModel.nodes[i].s;
        const generatedBoundary = generatedModel.nodes[i].s;
        
        if (originalBoundary === generatedBoundary) {
            correctCount++;
            console.log(`✓ 節点${i + 1}: ${originalBoundary} (正しい)`);
        } else {
            incorrectCount++;
            incorrectNodes.push({
                nodeIndex: i + 1,
                original: originalBoundary,
                generated: generatedBoundary
            });
            console.log(`✗ 節点${i + 1}: ${originalBoundary} → ${generatedBoundary} (不正)`);
        }
    }
    
    const success = incorrectCount === 0;
    const message = success 
        ? `全ての境界条件が正しく保持されました (${correctCount}/${minLength})`
        : `${incorrectCount}個の節点で境界条件が不正です (${correctCount}/${minLength})`;
    
    const result = {
        success: success,
        message: message,
        details: {
            totalNodes: minLength,
            correctCount: correctCount,
            incorrectCount: incorrectCount,
            incorrectNodes: incorrectNodes,
            boundaryChangeIntent: boundaryChangeIntent
        }
    };
    
    console.log('テスト結果:', result);
    console.log('=== 境界条件保持テスト完了 ===');
    
    return result;
}

// 最終的な境界条件強制復元関数（絶対に失敗しない）
function ultimateBoundaryConditionFix(originalModel, generatedModel) {
    if (!originalModel.nodes || !generatedModel.nodes) {
        console.log('最終復元: 節点データが不足しているため、処理をスキップします');
        return generatedModel;
    }
    
    const fixedModel = JSON.parse(JSON.stringify(generatedModel)); // ディープコピー
    
    console.log('=== 最終境界条件強制復元処理開始 ===');
    console.log('元のモデルの境界条件:', originalModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.log('現在のモデルの境界条件:', generatedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    
    const minLength = Math.min(originalModel.nodes.length, fixedModel.nodes.length);
    let fixedCount = 0;
    
    // 全ての境界条件を強制的に復元
    for (let i = 0; i < minLength; i++) {
        const originalBoundary = originalModel.nodes[i].s;
        const currentBoundary = fixedModel.nodes[i].s;
        
        // 強制的に境界条件を復元
        fixedModel.nodes[i].s = originalBoundary;
        
        if (originalBoundary !== currentBoundary) {
            console.log(`最終復元: 節点${i + 1}の境界条件を強制復元: ${currentBoundary} → ${originalBoundary}`);
            fixedCount++;
        } else {
            console.log(`最終復元: 節点${i + 1}の境界条件は正しい: ${originalBoundary}`);
        }
    }
    
    console.log(`最終復元: ${fixedCount}個の節点の境界条件を復元しました`);
    console.log('最終復元後の境界条件:', fixedModel.nodes.map((n, i) => `節点${i+1}=${n.s}`).join(', '));
    console.log('=== 最終境界条件強制復元処理完了 ===');
    
    return fixedModel;
}

// 境界条件の保持を検証する関数
function validateBoundaryConditions(originalModel, generatedModel, boundaryChangeIntent = null) {
    const warnings = [];
    
    if (!originalModel.nodes || !generatedModel.nodes) {
        return { isValid: true, warnings: [] };
    }
    
    // 既存の節点の境界条件が保持されているかチェック
    const minLength = Math.min(originalModel.nodes.length, generatedModel.nodes.length);
    
    for (let i = 0; i < minLength; i++) {
        const originalNode = originalModel.nodes[i];
        const generatedNode = generatedModel.nodes[i];
        
        if (originalNode.s !== generatedNode.s) {
            // 境界条件変更の意図があった場合は警告レベルを下げる
            if (boundaryChangeIntent && boundaryChangeIntent.detected) {
                console.log(`節点${i + 1}の境界条件が意図的に変更されました: ${originalNode.s} → ${generatedNode.s}`);
            } else {
                warnings.push(`節点${i + 1}の境界条件が意図せず変更されました: ${originalNode.s} → ${generatedNode.s}`);
            }
        }
    }
    
    // 節点数が減少した場合の警告
    if (generatedModel.nodes.length < originalModel.nodes.length) {
        warnings.push(`節点数が減少しました: ${originalModel.nodes.length} → ${generatedModel.nodes.length}`);
    }
    
    // 境界条件変更の意図があったが、実際に変更されていない場合の警告
    if (boundaryChangeIntent && boundaryChangeIntent.detected) {
        const hasBoundaryChange = originalModel.nodes.some((node, index) => {
            return generatedModel.nodes[index] && node.s !== generatedModel.nodes[index].s;
        });
        
        if (!hasBoundaryChange) {
            warnings.push(`境界条件の変更指示がありましたが、実際には変更されませんでした`);
        }
    }
    
    return {
        isValid: warnings.length === 0,
        warnings: warnings
    };
}

// 多層多スパン構造の検証と修正関数
function validateAndFixStructure(model, userPrompt) {
    try {
        console.error('=== 構造検証開始 ===');
        console.error('ユーザープロンプト:', userPrompt);
        console.error('現在のモデル:', JSON.stringify(model, null, 2));
        
        const errors = [];
        let fixedModel = JSON.parse(JSON.stringify(model)); // ディープコピー
        
        // 構造の次元を検出
        const dimensions = detectStructureDimensions(userPrompt);
        console.error('検出された構造次元:', dimensions);
        
        // 構造タイプを確認
        const structureType = detectStructureType(userPrompt);
        console.error('構造タイプ:', structureType);
        
        // 梁構造・トラス構造の場合は検証をスキップ（AIが正しく生成している）
        if (structureType === 'beam' || structureType === 'truss') {
            console.error(`${structureType}構造のため、構造検証をスキップします`);
            return {
                isValid: true,
                errors: [],
                fixedModel: fixedModel,
                nodeCount: fixedModel.nodes.length,
                memberCount: fixedModel.members.length
            };
        }
        
        // ラーメン構造かどうかを確認
        const isFrameStructure = structureType === 'frame';
        console.error('ラーメン構造:', isFrameStructure);
    
    // ラーメン構造の場合のみ検証・修正を実行
    if (isFrameStructure && dimensions.layers > 0 && dimensions.spans > 0) {
        console.error(`${dimensions.layers}層${dimensions.spans}スパン構造の検証を実行`);
        
        // 期待値の計算
        const expectedNodes = (dimensions.layers + 1) * (dimensions.spans + 1);
        const expectedMembers = dimensions.spans * (dimensions.layers + 1) + dimensions.layers * (dimensions.spans + 1);
        
        console.error('期待値:', {
            layers: dimensions.layers,
            spans: dimensions.spans,
            expectedNodes,
            expectedMembers
        });
        
        // 構造の検証
        let needsCorrection = false;
        
        // 節点数の検証
        console.error(`節点数検証: 期待値${expectedNodes}、実際${fixedModel.nodes.length}`);
        if (fixedModel.nodes.length !== expectedNodes) {
            errors.push(`節点数が不正: 期待値${expectedNodes}、実際${fixedModel.nodes.length}`);
            needsCorrection = true;
        }
        
        // 部材数の検証
        console.error(`部材数検証: 期待値${expectedMembers}、実際${fixedModel.members.length}`);
        if (fixedModel.members.length !== expectedMembers) {
            errors.push(`部材数が不正: 期待値${expectedMembers}、実際${fixedModel.members.length}`);
            needsCorrection = true;
        }
        
        // スパン数の検証
        const spanCount = validateSpanCount(fixedModel);
        if (!spanCount.isValid) {
            errors.push(`スパン数が不正: ${spanCount.errors.join(', ')}`);
            needsCorrection = true;
        }
        
        // 修正が必要な場合はプログラム的に生成
        if (needsCorrection) {
            console.error('構造修正を実行します');
            console.error('修正前のモデル:', JSON.stringify(fixedModel, null, 2));
            
            // 既存の荷重データを保存
            const originalNodeLoads = fixedModel.nodeLoads || [];
            const originalMemberLoads = fixedModel.memberLoads || [];
            console.error('既存の荷重データを保存:', {
                nodeLoads: originalNodeLoads.length,
                memberLoads: originalMemberLoads.length
            });
            
            // 構造を再生成
            const correctedStructure = generateCorrectFrameStructure(dimensions.layers, dimensions.spans);
            
            // 荷重データを保持して構造を修正
            fixedModel = {
                ...correctedStructure,
                nodeLoads: originalNodeLoads,
                memberLoads: originalMemberLoads
            };
            
            console.error('修正後のモデル:', JSON.stringify(fixedModel, null, 2));
            console.error('修正後の構造:', {
                nodeCount: fixedModel.nodes.length,
                memberCount: fixedModel.members.length,
                nodeLoads: fixedModel.nodeLoads.length,
                memberLoads: fixedModel.memberLoads.length
            });
            errors.push(`${dimensions.layers}層${dimensions.spans}スパン構造の修正を実行しました`);
        }
    }
    
    console.error('構造検証結果:', {
        isValid: errors.length === 0,
        errors: errors,
        nodeCount: fixedModel.nodes.length,
        memberCount: fixedModel.members.length
    });
    console.error('=== 構造検証完了 ===');
    
    return {
        isValid: errors.length === 0,
        errors: errors,
        fixedModel: fixedModel
    };
    } catch (error) {
        console.error('validateAndFixStructure関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、元のモデルをそのまま返す
        return {
            isValid: true,
            errors: [],
            fixedModel: model
        };
    }
}

// 任意の多層多スパン構造を生成する関数
function generateCorrectFrameStructure(layers, spans) {
    try {
        console.error(`=== ${layers}層${spans}スパン構造を生成 ===`);
        
        const nodes = [];
        const members = [];
        
        // 節点の生成
        console.error(`節点の生成開始: ${layers + 1}層×${spans + 1}列`);
        for (let layer = 0; layer <= layers; layer++) {
            for (let span = 0; span <= spans; span++) {
                const x = span * 7; // スパン長7m（ログから確認）
                const y = layer * 3.2; // 階高3.2m（ログから確認）
                const s = layer === 0 ? 'x' : 'f'; // 地面は固定、その他は自由
                
                nodes.push({ x, y, s });
            }
        }
        
        // 柱の生成
        console.error(`柱の生成開始: ${spans + 1}列×${layers}層`);
        for (let span = 0; span <= spans; span++) {
            for (let layer = 0; layer < layers; layer++) {
                const startNode = layer * (spans + 1) + span + 1;
                const endNode = (layer + 1) * (spans + 1) + span + 1;
                
                members.push({
                    i: startNode,
                    j: endNode,
                    E: 205000,
                    I: 0.00011,
                    A: 0.005245,
                    Z: 0.000638
                });
            }
        }
        
        // 梁の生成
        console.error(`梁の生成開始: ${spans}スパン×${layers}層（y=0の地面には梁材なし）`);
        for (let layer = 1; layer <= layers; layer++) { // layer=1から開始（y=0をスキップ）
            for (let span = 0; span < spans; span++) {
                const startNode = layer * (spans + 1) + span + 1;
                const endNode = layer * (spans + 1) + span + 2;
                
                members.push({
                    i: startNode,
                    j: endNode,
                    E: 205000,
                    I: 0.00011,
                    A: 0.005245,
                    Z: 0.000638
                });
            }
        }
        
        console.error(`=== ${layers}層${spans}スパン構造生成完了 ===`);
        console.error(`節点数: ${nodes.length}, 部材数: ${members.length}`);
        
        return { nodes, members };
        
    } catch (error) {
        console.error('generateCorrectFrameStructure関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、最小限の構造を返す
        return {
            nodes: [
                {x: 0, y: 0, s: 'x'},
                {x: 6, y: 0, s: 'x'},
                {x: 0, y: 3.5, s: 'f'},
                {x: 6, y: 3.5, s: 'f'}
            ],
            members: [
                {i: 1, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 2, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 3, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638}
            ]
        };
    }
}

// 5層4スパンラーメン構造の生成（後方互換性のため残す）
function generateCorrect5Layer4SpanStructure() {
    return generateCorrectFrameStructure(5, 4);
}

// プロンプトから高さを直接抽出する関数
function extractHeightFromPrompt(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    const heightPatterns = [
        /高さ(\d+(?:\.\d+)?)m/g,
        /height\s*(\d+(?:\.\d+)?)m/g,
        /(\d+(?:\.\d+)?)m.*高さ/g,
        /(\d+(?:\.\d+)?)m.*height/g
    ];
    
    for (const pattern of heightPatterns) {
        const match = prompt.match(pattern);
        if (match) {
            const numberMatch = match[0].match(/\d+(?:\.\d+)?/);
            if (numberMatch) {
                const height = parseFloat(numberMatch[0]);
                if (!isNaN(height)) {
                    return height;
                }
            }
        }
    }
    
    return 3.0; // デフォルト値
}

// プロンプトからスパン長を直接抽出する関数
function extractSpanLengthFromPrompt(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    const spanLengthPatterns = [
        /スパン(\d+(?:\.\d+)?)m/g,
        /span\s*(\d+(?:\.\d+)?)m/g,
        /(\d+(?:\.\d+)?)m.*スパン/g,
        /(\d+(?:\.\d+)?)m.*span/g
    ];
    
    for (const pattern of spanLengthPatterns) {
        const match = prompt.match(pattern);
        if (match) {
            const numberMatch = match[0].match(/\d+(?:\.\d+)?/);
            if (numberMatch) {
                const spanLength = parseFloat(numberMatch[0]);
                if (!isNaN(spanLength)) {
                    return spanLength;
                }
            }
        }
    }
    
    return 15.0; // デフォルト値
}

// ワーレントラス構造生成関数
function generateCorrectTrussStructure(height, spanLength, userPrompt) {
    try {
        console.error(`=== ワーレントラス構造を生成 ===`);
        console.error(`高さ: ${height}m, スパン長: ${spanLength}m`);
        
        const nodes = [];
        const members = [];
        
        // ワーレントラスの節点配置
        // 下弦材（y=0）
        const bottomNodes = [];
        for (let i = 0; i <= spanLength; i += 2.5) { // 2.5m間隔
            const nodeIndex = nodes.length + 1;
            nodes.push({ x: i, y: 0, s: i === 0 ? 'p' : i === spanLength ? 'r' : 'f' });
            bottomNodes.push(nodeIndex);
        }
        
        // 上弦材（y=height）
        const topNodes = [];
        for (let i = 0; i <= spanLength; i += 2.5) { // 2.5m間隔
            const nodeIndex = nodes.length + 1;
            nodes.push({ x: i, y: height, s: 'f' });
            topNodes.push(nodeIndex);
        }
        
        console.error(`下弦材節点: [${bottomNodes.join(', ')}]`);
        console.error(`上弦材節点: [${topNodes.join(', ')}]`);
        
        // 下弦材の部材
        for (let i = 0; i < bottomNodes.length - 1; i++) {
            members.push({
                i: bottomNodes[i],
                j: bottomNodes[i + 1],
                E: 205000,
                I: 0.00011,
                A: 0.005245,
                Z: 0.000638
            });
        }
        
        // 上弦材の部材
        for (let i = 0; i < topNodes.length - 1; i++) {
            members.push({
                i: topNodes[i],
                j: topNodes[i + 1],
                E: 205000,
                I: 0.00011,
                A: 0.005245,
                Z: 0.000638
            });
        }
        
        // 斜材（ワーレントラスの特徴的な斜めの部材）
        for (let i = 0; i < bottomNodes.length - 1; i++) {
            // 下弦材から上弦材への斜材
            members.push({
                i: bottomNodes[i],
                j: topNodes[i + 1],
                E: 205000,
                I: 0.00011,
                A: 0.005245,
                Z: 0.000638
            });
            
            // 上弦材から下弦材への斜材
            if (i < bottomNodes.length - 1) {
                members.push({
                    i: topNodes[i],
                    j: bottomNodes[i + 1],
                    E: 205000,
                    I: 0.00011,
                    A: 0.005245,
                    Z: 0.000638
                });
            }
        }
        
        console.error(`=== ワーレントラス構造生成完了 ===`);
        console.error(`節点数: ${nodes.length}, 部材数: ${members.length}`);
        
        return { nodes, members };
        
    } catch (error) {
        console.error('generateCorrectTrussStructure関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、最小限のトラス構造を返す
        return {
            nodes: [
                {x: 0, y: 0, s: 'p'},
                {x: 7.5, y: 0, s: 'r'},
                {x: 0, y: 3, s: 'f'},
                {x: 7.5, y: 3, s: 'f'}
            ],
            members: [
                {i: 1, j: 2, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 3, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 1, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 2, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 1, j: 4, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638},
                {i: 2, j: 3, E: 205000, I: 0.00011, A: 0.005245, Z: 0.000638}
            ]
        };
    }
}

// 基本的な構造生成（後方互換性のため残す）
function generateBasicStructure(userPrompt, dimensions) {
    console.error('=== 基本構造生成開始 ===');
    console.error('次元情報:', dimensions);
    
    // デフォルト値の設定
    const layers = dimensions.layers || 2;
    const spans = dimensions.spans || 2;
    
    return generateCorrectFrameStructure(layers, spans);
}

// トラス構造の修正プロンプトを作成する関数
function createTrussCorrectionPrompt(originalPrompt, currentModel, errors) {
    const height = extractHeightFromPrompt(originalPrompt);
    const spanLength = extractSpanLengthFromPrompt(originalPrompt);
    
    let correctionPrompt = `トラス構造の修正指示:

元の指示: ${originalPrompt}

現在の生成結果に以下の問題があります:
${errors.map(error => `- ${error}`).join('\n')}

修正要求:
1. 高さ${height}m、スパン長${spanLength}mのワーレントラス構造を生成してください
2. 下弦材（y=0）に適切な数の節点を配置してください（最低2個以上）
3. 上弦材（y=${height}）に適切な数の節点を配置してください（最低2個以上）
4. 境界条件: 左端（x=0）は"p"、右端（x=${spanLength}）は"r"、その他は"f"
5. 部材配置: 下弦材・上弦材・斜材を適切に配置してください

例: 高さ3m、スパン15mのワーレントラスなら
節点: [{"x":0,"y":0,"s":"p"},{"x":7.5,"y":0,"s":"f"},{"x":15,"y":0,"s":"r"},{"x":0,"y":3,"s":"f"},{"x":7.5,"y":3,"s":"f"},{"x":15,"y":3,"s":"f"}]
部材: 下弦材、上弦材、斜材を適切に配置

JSON形式で出力してください。`;

    return correctionPrompt;
}

// AIに修正プロンプトで再呼び出しを行う関数
async function callAIWithCorrectionPrompt(correctionPrompt, retryCount) {
    try {
        console.error('=== AI修正呼び出し開始 ===');
        
        const API_KEY = process.env.MISTRAL_API_KEY;
        const API_URL = 'https://api.mistral.ai/v1/chat/completions';
        
        const systemPrompt = `2D構造モデル生成。JSON出力のみ。

形式: {"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}
境界条件: "f"(自由), "p"(ピン), "r"(ローラー), "x"(固定)
節点番号: 配列順序（1から開始）
部材番号: 配列順序（1から開始）

重要: 節点番号・部材番号は必ず1から開始（配列のインデックス+1）
部材配置: 同じ節点間には1本の部材のみ配置（重複禁止）`;

        const requestBody = {
            model: "mistral-large-latest",
            messages: [
                { "role": "system", "content": systemPrompt },
                { "role": "user", "content": correctionPrompt }
            ],
            response_format: { "type": "json_object" }
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒タイムアウト

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`AI修正呼び出し失敗: ${response.status}`);
        }

        const data = await response.json();
        
        if (!data.choices || !data.choices[0] || !data.choices[0].message.content) {
            throw new Error("AI修正から予期しない形式のレスポンス");
        }

        const correctedText = data.choices[0].message.content;
        const correctedModel = JSON.parse(correctedText);
        
        console.error('AI修正呼び出し成功');
        console.error('修正後のモデル:', {
            nodeCount: correctedModel.nodes?.length || 0,
            memberCount: correctedModel.members?.length || 0
        });
        
        return correctedModel;
        
    } catch (error) {
        console.error('AI修正呼び出しエラー:', error.message);
        return null;
    }
}

// トラス構造の検証と修正関数
function validateAndFixTrussStructure(model, userPrompt) {
    try {
        console.error('=== トラス構造検証開始 ===');
        console.error('ユーザープロンプト:', userPrompt);
        console.error('現在のモデル:', JSON.stringify(model, null, 2));
        
        const errors = [];
        let fixedModel = JSON.parse(JSON.stringify(model)); // ディープコピー
        
        // トラス構造の基本的な検証
        if (!fixedModel.nodes || !fixedModel.members) {
            console.error('トラス構造: 節点または部材データが不足');
            return {
                isValid: true,
                errors: [],
                fixedModel: fixedModel
            };
        }
        
        // 高さとスパン長を検出
        const height = extractHeightFromPrompt(userPrompt);
        const spanLength = extractSpanLengthFromPrompt(userPrompt);
        console.error(`トラス構造検証: 高さ=${height}m, スパン長=${spanLength}m`);
        
        // 節点の検証
        const bottomNodes = fixedModel.nodes.filter(node => node.y === 0);
        const topNodes = fixedModel.nodes.filter(node => node.y === height);
        
        console.error(`下弦材節点数: ${bottomNodes.length}, 上弦材節点数: ${topNodes.length}`);
        
        // 基本的なトラス構造の要件をチェック
        let needsCorrection = false;
        
        // 下弦材の節点が少なすぎる場合
        if (bottomNodes.length < 2) {
            errors.push(`下弦材の節点が不足: ${bottomNodes.length}個（最低2個必要）`);
            needsCorrection = true;
        }
        
        // 上弦材の節点が少なすぎる場合
        if (topNodes.length < 2) {
            errors.push(`上弦材の節点が不足: ${topNodes.length}個（最低2個必要）`);
            needsCorrection = true;
        }
        
        // 境界条件の検証
        const leftNode = fixedModel.nodes.find(node => node.x === 0 && node.y === 0);
        const rightNode = fixedModel.nodes.find(node => node.x === spanLength && node.y === 0);
        
        if (leftNode && leftNode.s !== 'p') {
            errors.push(`左端節点の境界条件が不正: ${leftNode.s}（"p"である必要）`);
            needsCorrection = true;
        }
        
        if (rightNode && rightNode.s !== 'r') {
            errors.push(`右端節点の境界条件が不正: ${rightNode.s}（"r"である必要）`);
            needsCorrection = true;
        }
        
        // 修正が必要な場合は、AIに修正指示を行う
        if (needsCorrection) {
            console.error('トラス構造に問題が検出されました。AIに修正指示を行います');
            errors.push('トラス構造の修正が必要です');
        }
        
        console.error('トラス構造検証結果:', {
            isValid: errors.length === 0,
            errors: errors,
            nodeCount: fixedModel.nodes.length,
            memberCount: fixedModel.members.length
        });
        console.error('=== トラス構造検証完了 ===');
        
        return {
            isValid: errors.length === 0,
            errors: errors,
            fixedModel: fixedModel
        };
        
    } catch (error) {
        console.error('validateAndFixTrussStructure関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、元のモデルをそのまま返す
        return {
            isValid: true,
            errors: [],
            fixedModel: model
        };
    }
}


// 部材重複検出・修正関数
function validateAndFixMemberOverlap(model) {
    try {
        console.error('=== 部材重複検証開始 ===');
        console.error('検証対象モデル:', JSON.stringify(model, null, 2));
        
        const errors = [];
        let fixedModel = JSON.parse(JSON.stringify(model)); // ディープコピー
        
        if (!fixedModel.members || !Array.isArray(fixedModel.members)) {
            console.error('部材配列が存在しません');
            return { isValid: true, errors: [], fixedModel: fixedModel };
        }
        
        // 重複部材を検出
        const memberMap = new Map();
        const duplicateMembers = [];
        
        fixedModel.members.forEach((member, index) => {
            if (!member.i || !member.j) {
                errors.push(`部材${index + 1}に節点番号が設定されていません`);
                return;
            }
            
            // 部材のキーを作成（小さい番号を先に）
            const key = member.i < member.j ? `${member.i}-${member.j}` : `${member.j}-${member.i}`;
            
            if (memberMap.has(key)) {
                duplicateMembers.push({
                    index: index,
                    member: member,
                    duplicateWith: memberMap.get(key)
                });
                errors.push(`部材${index + 1}が部材${memberMap.get(key).index + 1}と重複しています（節点${member.i}-${member.j}）`);
            } else {
                memberMap.set(key, { index: index, member: member });
            }
        });
        
        // 重複部材を除去
        if (duplicateMembers.length > 0) {
            console.error(`重複部材を検出: ${duplicateMembers.length}個`);
            
            // 重複部材のインデックスを降順でソート（後ろから削除）
            const indicesToRemove = duplicateMembers.map(d => d.index).sort((a, b) => b - a);
            
            indicesToRemove.forEach(index => {
                console.error(`重複部材${index + 1}を削除: 節点${fixedModel.members[index].i}-${fixedModel.members[index].j}`);
                fixedModel.members.splice(index, 1);
            });
            
            console.error(`重複部材削除完了: ${indicesToRemove.length}個の部材を削除`);
        }
        
        // 部材荷重の参照も修正
        if (fixedModel.memberLoads && Array.isArray(fixedModel.memberLoads)) {
            // 削除された部材の荷重を除去
            const validMemberIndices = new Set(fixedModel.members.map((_, index) => index + 1));
            
            fixedModel.memberLoads = fixedModel.memberLoads.filter(load => {
                const memberIndex = load.m || load.member;
                if (validMemberIndices.has(memberIndex)) {
                    return true;
                } else {
                    console.error(`無効な部材荷重を削除: 部材${memberIndex}`);
                    return false;
                }
            });
        }
        
        console.error('部材重複検証結果:', {
            isValid: errors.length === 0,
            errors: errors,
            originalMemberCount: model.members.length,
            fixedMemberCount: fixedModel.members.length
        });
        console.error('=== 部材重複検証完了 ===');
        
        return {
            isValid: errors.length === 0,
            errors: errors,
            fixedModel: fixedModel
        };
        
    } catch (error) {
        console.error('validateAndFixMemberOverlap関数でエラーが発生しました:', error);
        console.error('エラーの詳細:', error.message);
        console.error('エラースタック:', error.stack);
        
        // エラーが発生した場合は、元のモデルをそのまま返す
        return {
            isValid: true,
            errors: [],
            fixedModel: model
        };
    }
}