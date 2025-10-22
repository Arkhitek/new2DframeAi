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

        // API設定（容量制限エラー時に自動切り替え）
        let API_KEY = process.env.GROQ_API_KEY;
        let API_URL = 'https://api.groq.com/openai/v1/chat/completions';
        let apiProvider = 'groq';
        
        if (!API_KEY) {
            throw new Error("Groq AIのAPIキーがサーバーに設定されていません。");
        }
        
        // retryCount変数を先に定義
        let retryCount = 0;
        
        // 構造の次元を事前に検出（検証時に再利用）
        const detectedDimensions = detectStructureDimensions(userPrompt, mode === 'edit' ? currentModel : null);
        console.error('事前検出した構造次元:', detectedDimensions);
        
        const systemPrompt = createSystemPromptForBackend(mode, currentModel, userPrompt, retryCount);
        
        // 追加編集モードの場合は現在のモデル情報を含めてプロンプトを作成
        let userMessage = userPrompt;
        if (mode === 'edit' && currentModel) {
            userMessage = createEditPrompt(userPrompt, currentModel);
        }

        // モデル設定（容量制限エラー時に自動切り替え）
        let aiModel = "llama-3.3-70b-versatile";
        let modelSwitched = false;
        
        const requestBody = {
            model: aiModel,
            messages: [
                { "role": "system", "content": systemPrompt },
                { "role": "user", "content": userMessage }
            ],
            response_format: { "type": "json_object" }
        };

        // 最適化されたリトライ機能付きAI呼び出し
        let groqResponse;
        let data;
        const maxRetries = 3; // リトライ回数を3回に最適化
        let lastError = null;
        
        while (retryCount <= maxRetries) {
            try {
                console.error(`AI呼び出し試行 ${retryCount + 1}/${maxRetries + 1}`);
                
                // タイムアウト設定を追加
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒タイムアウト
                
                groqResponse = await fetch(API_URL, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                data = await groqResponse.json();
                console.error('AIレスポンス受信: ステータス=', groqResponse.status);
                console.error('AIレスポンス詳細:', JSON.stringify(data, null, 2));

                // 成功した場合はループを抜ける
                if (groqResponse.ok) {
                    console.error(`✅ AI呼び出し成功 (${retryCount + 1}回目) - 使用プロバイダー: ${apiProvider}, モデル: ${aiModel}`);
                    break;
                }
                
                // 容量制限エラーの場合
                if (groqResponse.status === 429) {
                    console.error(`容量制限エラー検出 (試行 ${retryCount + 1}/${maxRetries + 1}) - 現在のプロバイダー: ${apiProvider}`);
                    
                    // まだモデルを切り替えていない場合、llama-3.1-8b-instantに切り替え
                    if (!modelSwitched && aiModel === "llama-3.3-70b-versatile") {
                        console.error('🔄 容量制限のため、モデルをllama-3.1-8b-instantに切り替えます');
                        aiModel = "llama-3.1-8b-instant";
                        modelSwitched = true;
                        requestBody.model = aiModel;
                        
                        // モデル切り替え後は即座に再試行
                        retryCount++;
                        continue;
                    }
                    
                    // llama-3.1-8b-instantでも容量制限の場合、Mistral APIに切り替え
                    if (apiProvider === 'groq' && aiModel === "llama-3.1-8b-instant") {
                        console.error('🔄 Groq APIの容量制限のため、Mistral APIに切り替えます');
                        
                        // Mistral APIに切り替え
                        const mistralApiKey = process.env.MISTRAL_API_KEY;
                        if (!mistralApiKey) {
                            console.error('❌ Mistral APIキーが設定されていません');
                            throw new Error("Mistral APIキーがサーバーに設定されていません。容量制限回避のためMistral APIへの切り替えができません。");
                        }
                        
                        API_KEY = mistralApiKey;
                        API_URL = 'https://api.mistral.ai/v1/chat/completions';
                        apiProvider = 'mistral';
                        aiModel = "mistral-large-latest";
                        requestBody.model = aiModel;
                        
                        console.error('✅ Mistral APIに切り替え完了');
                        
                        // API切り替え後は即座に再試行
                        retryCount++;
                        continue;
                    }
                    
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
                lastError = new Error(data.message || 'Groq AIでエラーが発生しました。');
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
                
                // 荷重データ保持処理
                console.error('編集モード: 荷重データ保持処理開始');
                generatedModel = preserveLoadData(currentModel, generatedModel, userPrompt);
                finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                console.error('編集モード: 荷重データ保持処理完了');
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
            
            const structureValidation = await validateAndFixStructure(
                generatedModel, 
                userPrompt, 
                mode === 'edit' ? currentModel : null,
                detectedDimensions
            );
            
            if (!structureValidation.isValid) {
                console.error('構造検証エラー:', structureValidation.errors);
                generatedModel = structureValidation.fixedModel;
                finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                console.error('構造修正完了');
            } else {
                console.error('構造検証成功');
            }
            
            // 構造タイプ別の追加検証・修正を実行
            const detectedStructureType = detectStructureType(userPrompt, mode === 'edit' ? currentModel : null);
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
            } else if (detectedStructureType === 'arch') {
                console.error('アーチ構造: 基本検証のみ実行');
                // アーチ構造は形状が多様なため、詳細な検証はスキップ
                // AIが生成した構造をそのまま使用
                console.error('アーチ構造検証成功');
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
            } else if (detectedStructureType === 'frame') {
                // フレーム構造の検証でAI修正が必要な場合
                const structureValidation = await validateAndFixStructure(
                    generatedModel, 
                    userPrompt,
                    mode === 'edit' ? currentModel : null,
                    detectedDimensions
                );
                if (!structureValidation.isValid && structureValidation.needsAICorrection) {
                    console.error('門型ラーメン検証エラー:', structureValidation.errors);
                    
                    // ラーメン構造の修正プロンプトを作成
                    const correctionPrompt = createFrameCorrectionPrompt(userPrompt, generatedModel, structureValidation.errors);
                    console.error('ラーメン構造修正プロンプト:', correctionPrompt);
                    
                    // 修正プロンプトでAIを再呼び出し
                    const correctedResponse = await callAIWithCorrectionPrompt(correctionPrompt, retryCount);
                    if (correctedResponse) {
                        generatedModel = correctedResponse;
                        finalGeneratedText = JSON.stringify(generatedModel, null, 2);
                        console.error('ラーメン構造AI修正完了');
                    } else {
                        console.error('ラーメン構造AI修正に失敗、元のモデルを使用');
                    }
                }
            } else if (detectedStructureType === 'basic') {
                console.error('一般構造: AIの判断を尊重し、柔軟な検証のみ実行');
                // 特定の構造タイプが指定されていない場合は、
                // AIが適切に判断した構造をそのまま使用
                // 基本的な検証（節点参照、部材重複）のみ実行
                console.error('一般構造検証: 基本検証のみ実行');
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
    const structureType = detectStructureType(userPrompt, mode === 'edit' ? currentModel : null);
    const dimensions = detectStructureDimensions(userPrompt, mode === 'edit' ? currentModel : null);
    const loadIntent = detectLoadIntent(userPrompt);
    
    // リトライ回数に応じてプロンプトを簡潔化
    if (retryCount >= 2) {
        // 3回目以降は極限まで簡潔
        let simplePrompt = `2D構造生成。JSON出力のみ。
{"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638, "name": "断面名称"}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}
境界条件: "f","p","r","x"
節点番号: 配列順序（1から開始、0は使用禁止、必ず整数）
部材番号: 配列順序（1から開始、0は使用禁止、必ず整数）
荷重単位: kNで指定された場合はそのまま使用
部材name: 指定された断面名称（例: "H-200×100×8×12"）`;

        // 鋼材情報が提供されているかチェック
        const hasSteelSections = userPrompt.includes('【鋼材') || userPrompt.includes('指定断面:');
        if (hasSteelSections) {
            simplePrompt += `
鋼材: 「指定断面:」の値を部材nameに使用。例: "H-200×100×8×12"`;
        }

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
重要: 下弦材の左端（x=0,y=0）は"p"、下弦材の右端（x=${spanLength},y=0）は"r"、その他は"f"、上弦材には支点を配置しない`;
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

形式: {"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638, "name": "断面名称"}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}

基本ルール:
- 境界条件: "f"(自由), "p"(ピン), "r"(ローラー), "x"(固定)
- 節点番号: 配列順序（1から開始、0は使用禁止、必ず整数）
- 部材番号: 配列順序（1から開始、0は使用禁止、必ず整数）
- 座標: メートル単位で小数点以下1桁まで、必ず数値型で指定（文字列禁止）
- 荷重単位: kN（キロニュートン）で指定された場合はそのまま使用、N（ニュートン）の場合は1000で割る
- 材料定数: E=205000MPa, I=0.00011m⁴, A=0.005245m², Z=0.000638m³
- 部材name: 指定された断面名称を必ず含める（例: "H-200×100×8×12"、"H-300×150"など）

重要制約:
- 同じ節点間には1本の部材のみ配置（重複禁止）
- 節点番号・部材番号は必ず1から開始（配列のインデックス+1）
- 存在しない節点番号を部材で参照しない`;

    // 鋼材情報が提供されているかチェック
    const hasSteelSections = userPrompt.includes('【鋼材') || userPrompt.includes('指定断面:');
    if (hasSteelSections) {
        prompt += `

重要: 鋼材断面情報が提供されています
- 部材のnameフィールドには、必ず「- 指定断面: 」に続く値を使用してください
- 例: 「- 指定断面: H-200×100×8×12」 → 部材のname: "H-200×100×8×12"
- 柱部材と梁部材で異なる断面が指定されている場合、それぞれ適切な断面名称を使用
- 部材のI、A、Zの値は提供された断面性能値を正確に使用してください
- 断面性能値は上記の【鋼材】セクションに記載されている値をそのまま使用
- 例: H-200×200×8×12の場合、I=0.0472, A=0.006353, Z=0.00472を使用`;
    }
    
    // 荷重指示の有無に基づいて条件分岐
    if (loadIntent.hasLoadIntent) {
        prompt += `
荷重: 指示に応じて適切な荷重を生成（集中荷重、等分布荷重、水平荷重など）
等分布荷重: 特に指示がない場合はプラスの値（下向き）で生成`;
    } else {
        prompt += `
荷重: 荷重の指示がない場合は、nodeLoadsとmemberLoadsは空配列[]で出力`;
    }

    // 構造タイプに応じたプロンプト生成（キャッシュ機能付き）
    console.error('構造タイプ:', structureType);
    
    // プロンプトキャッシュのキーを生成
    const promptCacheKey = `${structureType}_${loadIntent.hasLoadIntent ? 'with_loads' : 'no_loads'}`;
    console.error('プロンプトキャッシュキー:', promptCacheKey);
    
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
    } else if (structureType === 'arch') {
        // アーチ構造の詳細なプロンプト
        const spanLength = extractSpanLengthFromPrompt(userPrompt);
        const rise = extractRiseFromPrompt(userPrompt);  // 矢高を抽出
        
        prompt += `
アーチ構造: スパン${spanLength}m、矢高${rise}m
重要な特徴:
1. アーチ形状（放物線または円弧状）に節点を配置
2. 両端の支点はy=0に配置（通常はピン支点"p"）
3. 中間節点はアーチ曲線に沿って配置し、全て"f"（自由）

節点配置の原則:
- 両端（x=0とx=${spanLength}）: y=0、境界条件"p"（ピン支点）
- 中間節点: アーチ曲線に沿って配置（8～12個程度）
- 最高点: x=${spanLength / 2}、y=${rise}
- 曲線式: 放物線 y = 4*${rise}/${spanLength}²*(x-${spanLength}/2)² を使用

部材配置の原則:
- 隣接する節点を順番に接続（アーチ曲線を形成）
- 節点1→2→3→...→最終節点

境界条件:
- 両端: "p"（ピン支点）または"r"（ローラー支点）
- 中間節点: 全て"f"（自由）`;
        
        if (loadIntent.hasLoadIntent) {
            prompt += `

荷重: アーチの節点に適切な荷重を生成（等分布荷重を節点荷重に変換）`;
        }
        
        // 具体的な例を追加
        prompt += `

例: スパン20m、矢高4mのアーチ
節点（9個）: アーチ曲線に沿って配置
- 節点1: (0, 0, "p") - 左端支点
- 節点2: (2.5, 1, "f")
- 節点3: (5, 2, "f")
- 節点4: (7.5, 3, "f")
- 節点5: (10, 4, "f") - 最高点
- 節点6: (12.5, 3, "f")
- 節点7: (15, 2, "f")
- 節点8: (17.5, 1, "f")
- 節点9: (20, 0, "p") - 右端支点

部材（8本）: 1→2, 2→3, 3→4, 4→5, 5→6, 6→7, 7→8, 8→9

重要: アーチの両端はy=0に配置し、ピン支点とします。`;
    } else if (structureType === 'truss') {
        // トラス構造の詳細なプロンプト
        const height = extractHeightFromPrompt(userPrompt);
        const spanLength = extractSpanLengthFromPrompt(userPrompt);
        
        prompt += `
ワーレントラス構造: 高さ${height}m、スパン長${spanLength}m
重要な特徴:
1. 垂直材を使用しない（斜材のみで構成）
2. 斜材が上向き・下向きと交互に配置（ジグザグの「W」字形状）
3. 上弦材の節点は下弦材の節点の中間位置に配置

節点配置の原則:
- 下弦材（y=0）: スパンを等分割した位置に配置（例: 4パネルなら x=0, 3.75, 7.5, 11.25, 15）
- 上弦材（y=${height}）: 下弦材の中間位置に配置（例: x=1.875, 5.625, 9.375, 13.125）
- 境界条件: 下弦材の左端（x=0,y=0）は"p"、下弦材の右端は"r"、その他は"f"

部材配置の原則:
- 下弦材: 下弦の節点を順に接続（水平材）
- 上弦材: 上弦の節点を順に接続（水平材）
- 斜材: 交互に上向き・下向きに配置（垂直材は絶対に配置しない）
  * 上向き斜材: 下弦材の節点から右上の上弦材の節点へ
  * 下向き斜材: 上弦材の節点から右下の下弦材の節点へ`;
        
        if (loadIntent.hasLoadIntent) {
            prompt += `

荷重: 上弦材の節点に集中荷重を生成（トラスの特性上、節点荷重のみ）`;
        }
        
        // 具体的な例を追加（4パネルのワーレントラス）
        prompt += `

例: 高さ3m、スパン15mのワーレントラス（4パネル）
節点（9個）:
- 下弦材（y=0）: 節点1(0,0,"p"), 節点2(3.75,0,"f"), 節点3(7.5,0,"f"), 節点4(11.25,0,"f"), 節点5(15,0,"r")
- 上弦材（y=3）: 節点6(1.875,3,"f"), 節点7(5.625,3,"f"), 節点8(9.375,3,"f"), 節点9(13.125,3,"f")

部材（16本）:
- 下弦材: 1→2, 2→3, 3→4, 4→5
- 上弦材: 6→7, 7→8, 8→9
- 斜材（上向き）: 1→6, 2→7, 3→8, 4→9
- 斜材（下向き）: 6→2, 7→3, 8→4, 9→5

重要: この形状が「W」字のジグザグパターンを作ります。垂直材（例: 1→6の真下から真上）は絶対に配置しないでください。`;
    } else if (structureType === 'frame') {
        // 門型ラーメンの特別処理
        if (dimensions.isPortalFrame) {
            // プロンプトから高さとスパンの値を抽出
            const height = extractHeightFromPrompt(userPrompt);
            const spanLength = extractSpanLengthFromPrompt(userPrompt);
            
            prompt += `
門型ラーメン（ポータルフレーム）: 4節点、3部材（左柱、梁、右柱）
節点配置: 
- 左柱脚（x=0, y=0, s="x"）
- 左柱頭（x=0, y=${height}, s="f"）
- 右柱頭（x=${spanLength}, y=${height}, s="f"）
- 右柱脚（x=${spanLength}, y=0, s="x"）
境界条件: 柱脚は"x"（固定支点）、柱頭は"f"（自由）
部材配置: 
- 左柱: 節点1→節点2（i=1, j=2）
- 梁: 節点2→節点3（i=2, j=3）
- 右柱: 節点3→節点4（i=3, j=4）
重要: 4節点、3部材のみで構成、追加の節点や部材を作成しない`;
            if (loadIntent.hasLoadIntent) {
                prompt += `
荷重: 梁や柱頭に適切な荷重を生成（水平荷重、鉛直荷重、等分布荷重など）`;
            }
        }
        // 層数・スパン数が検出された場合のみ詳細ルールを追加
        else if (dimensions.layers > 0 && dimensions.spans > 0) {
            const expectedNodes = (dimensions.layers + 1) * (dimensions.spans + 1);
            const expectedColumns = (dimensions.spans + 1) * dimensions.layers;
            const expectedBeams = dimensions.spans * dimensions.layers; // y=0の地面には梁材なし
            const expectedMembers = expectedColumns + expectedBeams;
            
            prompt += `
ラーメン(${dimensions.layers}層${dimensions.spans}スパン): 節点${expectedNodes}個、部材${expectedMembers}個（柱${expectedColumns}本+梁${expectedBeams}本）
座標: X=0,6,12...m、Y=0,3.5,7...m
境界条件: 地面節点（y=0）は"x"、上部節点は"f"
部材配置: 
- 柱: 各柱通りに下から上へ連続的に配置（節点1→4→7...、節点2→5→8...）
- 梁: 各層で水平方向に配置（節点4→5→6...、節点7→8→9...）
- 重要: y=0の地面には梁材（水平材）を配置しない`;
            if (loadIntent.hasLoadIntent) {
                prompt += `
荷重: 各層に水平荷重、適切な節点に集中荷重を生成`;
            }
            
            // 具体的な例を追加（3層2スパンの場合）
            if (dimensions.layers === 3 && dimensions.spans === 2) {
                prompt += `

例: 3層2スパンの場合
節点: 12個（4層×3列）
- 地面（y=0）: 節点1(0,0,x), 節点2(6,0,x), 節点3(12,0,x)
- 1層（y=3.5）: 節点4(0,3.5,f), 節点5(6,3.5,f), 節点6(12,3.5,f)
- 2層（y=7）: 節点7(0,7,f), 節点8(6,7,f), 節点9(12,7,f)
- 3層（y=10.5）: 節点10(0,10.5,f), 節点11(6,10.5,f), 節点12(12,10.5,f)
部材: 15本（柱9本+梁6本）
- 柱: 1→4, 4→7, 7→10, 2→5, 5→8, 8→11, 3→6, 6→9, 9→12
- 梁: 4→5, 5→6, 7→8, 8→9, 10→11, 11→12`;
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

    // 一般的な構造（構造タイプが指定されていない場合）
    if (structureType === 'basic') {
        prompt += `

一般的な2D構造の生成:
指示内容から構造の種類を柔軟に判断し、適切なモデルを生成してください。

構造タイプの判断基準:
- ラーメン構造: 柱と梁で構成、地面に固定支点、多層多スパン
- トラス構造: 三角形要素で構成、ピンとローラー支点、斜材が重要
- アーチ構造: 曲線形状、両端がy=0に支点、圧縮力が主
- 梁構造: 水平材、両端に支点、曲げモーメントが主
- その他: 指示に応じて最適な構造形式を選択

境界条件の選択:
- 固定支点("x"): 回転・移動を完全拘束（ラーメンの柱脚など）
- ピン支点("p"): 回転自由、移動拘束（トラスの支点、アーチの両端など）
- ローラー支点("r"): 回転・水平移動自由（トラスの片側支点など）
- 自由("f"): 拘束なし（中間節点）

指示内容をよく読み、最も適切な構造形式で生成してください。`;
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
    } else if (structureType === 'arch') {
        prompt += `
重要: 節点番号は存在するもののみ参照、アーチの両端はy=0に配置`;
    } else {
        prompt += `
重要: 節点番号は存在するもののみ参照、指示内容に応じて適切な境界条件を設定`;
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
重要: 節点番号・部材番号は必ず1から開始（配列のインデックス+1）、0は絶対に使用禁止
部材配置: 同じ節点間には1本の部材のみ配置（重複禁止）`;

    return prompt;
}

// 構造タイプを検出する関数
function detectStructureType(userPrompt, currentModel = null) {
    const prompt = userPrompt.toLowerCase();
    
    // 編集モードの場合、まず元のモデルから構造タイプを推定
    if (currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        console.error('元のモデルから構造タイプを推定');
        
        // Y座標のバリエーションを取得
        const uniqueY = [...new Set(currentModel.nodes.map(n => n.y))].sort((a, b) => a - b);
        const layers = uniqueY.length - 1; // 地面を除く層数
        
        // 固定支点の数をカウント
        const fixedSupports = currentModel.nodes.filter(n => n.s === 'x' || n.s === 'fixed').length;
        
        // ピン支点の数をカウント
        const pinSupports = currentModel.nodes.filter(n => n.s === 'p' || n.s === 'pin' || n.s === 'pinned').length;
        
        // ラーメン構造の特徴: 複数層、固定支点、柱と梁の構成
        if (layers >= 2 && fixedSupports > 0) {
            console.error('元のモデルはラーメン構造と推定（層数:', layers, '、固定支点:', fixedSupports, '）');
            
            // プロンプトに明示的な構造タイプ変更の指示がある場合のみ、変更を許可
            const structureChangeKeywords = ['に変更', 'を変更', 'として', 'トラス化', '梁化', '梁構造に', 'トラス構造に', 'アーチ構造に'];
            const hasStructureChange = structureChangeKeywords.some(keyword => prompt.includes(keyword));
            
            if (!hasStructureChange) {
                // 構造タイプ変更の指示がない場合は、元のラーメン構造を維持
                console.error('構造タイプ変更の指示なし、ラーメン構造を維持');
                return 'frame';
            }
        }
        
        // トラス構造の特徴: 1層、ピン支点
        if (layers === 1 && pinSupports >= 2) {
            console.error('元のモデルはトラス構造と推定');
            
            // 構造タイプ変更の指示がない場合は維持
            const structureChangeKeywords = ['に変更', 'を変更', 'として', 'ラーメン化', '梁化', '梁構造に', 'ラーメン構造に', 'アーチ構造に'];
            const hasStructureChange = structureChangeKeywords.some(keyword => prompt.includes(keyword));
            
            if (!hasStructureChange) {
                console.error('構造タイプ変更の指示なし、トラス構造を維持');
                return 'truss';
            }
        }
        
        // 梁構造の特徴: 1層、少数の支点
        if (layers === 1) {
            console.error('元のモデルは梁構造と推定');
            
            // 構造タイプ変更の指示がない場合は維持
            const structureChangeKeywords = ['に変更', 'を変更', 'として', 'ラーメン化', 'トラス化', 'トラス構造に', 'ラーメン構造に', 'アーチ構造に'];
            const hasStructureChange = structureChangeKeywords.some(keyword => prompt.includes(keyword));
            
            if (!hasStructureChange) {
                console.error('構造タイプ変更の指示なし、梁構造を維持');
                return 'beam';
            }
        }
    }
    
    // プロンプトから構造タイプを検出（新規作成時、または構造タイプ変更時）
    
    // アーチ構造のキーワード（最優先）
    const archKeywords = ['アーチ', 'arch', '矢高', 'ライズ', 'rise'];
    if (archKeywords.some(keyword => prompt.includes(keyword))) {
        return 'arch';
    }
    
    // ラーメン構造のキーワード
    const frameKeywords = ['ラーメン', 'フレーム', 'frame', '門型', '多層', '層', '柱', '階'];
    if (frameKeywords.some(keyword => prompt.includes(keyword))) {
        return 'frame';
    }
    
    // トラス構造のキーワード
    const trussKeywords = ['トラス', 'truss', 'ワーレン', 'warren', 'プラット', 'pratt', 'ハウ', 'howe', '斜材', '弦材'];
    if (trussKeywords.some(keyword => prompt.includes(keyword))) {
        return 'truss';
    }
    
    // 梁構造のキーワード（「梁部材」「既存の梁」などは除外）
    const beamStructureKeywords = ['連続梁', '単純梁', 'beam', '連続', '単純', 'キャンチレバー', '片持ち梁', 'cantilever'];
    if (beamStructureKeywords.some(keyword => prompt.includes(keyword))) {
        // 「梁部材」「既存の梁」などの文脈でないことを確認
        if (!prompt.includes('梁部材') && !prompt.includes('既存の梁') && !prompt.includes('梁と同様')) {
            return 'beam';
        }
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
// 境界条件を正規化する関数（長い形式 → 短い形式）
function normalizeBoundaryCondition(condition) {
    if (!condition) return 'f';
    
    const conditionLower = condition.toString().toLowerCase();
    
    // 正規化マッピング
    const mapping = {
        'fixed': 'x',
        'fix': 'x',
        'x': 'x',
        'pin': 'p',
        'pinned': 'p',
        'hinge': 'p',
        'p': 'p',
        'roller': 'r',
        'r': 'r',
        'free': 'f',
        'f': 'f'
    };
    
    return mapping[conditionLower] || 'f';
}

// 現在のモデルから層数とスパン数を検出する関数
function detectDimensionsFromModel(model) {
    if (!model || !model.nodes || model.nodes.length === 0) {
        return { layers: 1, spans: 1 };
    }
    
    // Y座標をグループ化して層数を検出
    const yCoordinates = [...new Set(model.nodes.map(node => node.y))].sort((a, b) => a - b);
    const layers = yCoordinates.length - 1; // 地面を除いた層数
    
    // 各Y座標での節点数からスパン数を検出
    const nodesByY = {};
    model.nodes.forEach(node => {
        const y = node.y;
        if (!nodesByY[y]) {
            nodesByY[y] = [];
        }
        nodesByY[y].push(node);
    });
    
    // 最も多い節点数を持つ層からスパン数を計算（節点数 - 1 = スパン数）
    const nodeCounts = Object.values(nodesByY).map(nodes => nodes.length);
    const maxNodeCount = Math.max(...nodeCounts);
    const spans = maxNodeCount - 1;
    
    console.error('モデルから構造次元を検出:', {
        yCoordinates,
        layers,
        maxNodeCount,
        spans
    });
    
    return {
        layers: Math.max(1, layers),
        spans: Math.max(1, spans)
    };
}

function detectStructureDimensions(userPrompt, currentModel = null) {
    const prompt = userPrompt.toLowerCase();
    
    // 構造変更の明示的な指示があるかチェック
    // パターンマッチングで、数字+キーワードの組み合わせのみ検出
    const hasLayers = /\d+\s*(層|階|story|floor)/.test(prompt);
    const hasSpans = /\d+\s*(スパン|span|間)/.test(prompt);
    const hasPortal = /(門型|門形|portal\s*frame|portal)/.test(prompt);
    const hasStructureChange = hasLayers || hasSpans || hasPortal;
    
    // 編集モードで構造変更の指示がない場合、現在のモデルから検出
    if (!hasStructureChange && currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        console.error('編集モード: 構造変更の指示なし、現在のモデルから次元を検出');
        const modelDimensions = detectDimensionsFromModel(currentModel);
        console.error('モデルから検出した次元:', modelDimensions);
        return modelDimensions;
    }
    
    // 門型ラーメンの検出（最優先）
    const portalFrameKeywords = ['門型', '門形', 'portal frame', 'portal'];
    const isPortalFrame = portalFrameKeywords.some(keyword => prompt.includes(keyword));
    
    if (isPortalFrame) {
        console.error('門型ラーメンを検出: 1層1スパンとして処理');
        return {
            layers: 1,
            spans: 1,
            isPortalFrame: true
        };
    }
    
    // 「追加」モードの検出
    const isAddMode = /追加|延長|増設|増築/.test(prompt);
    
    // 層数の検出（より柔軟な検出）
    let layers = 1;
    let layersToAdd = 0; // 追加する層数
    
    // 「X階部分を追加」は「X階（X層目）を追加」= 1層だけ追加
    // 「X層を追加」は「X層を追加」= X層追加
    const addFloorPattern = /(\d+)\s*階\s*(部分|を|の)*\s*(追加|延長|増設|増築)/;
    const addLayerPattern = /(\d+)\s*層\s*(を|の)*\s*(追加|延長|増設|増築)/;
    
    let isLayerAddition = false;
    
    // まず「X階部分を追加」をチェック（1層だけ追加）
    const floorMatch = prompt.match(addFloorPattern);
    if (floorMatch) {
        // 「X階部分を追加」は1層だけ追加（X階目を追加する意味）
        layersToAdd = 1;
        isLayerAddition = true;
        const floorNumber = parseInt(floorMatch[0].match(/\d+/)[0], 10);
        console.error(`階追加モード検出: ${floorNumber}階部分を追加（1層追加）`);
    } else {
        // 次に「X層を追加」をチェック（X層追加）
        const layerMatch = prompt.match(addLayerPattern);
        if (layerMatch) {
            const numberMatch = layerMatch[0].match(/\d+/);
            if (numberMatch) {
                layersToAdd = parseInt(numberMatch[0], 10);
                isLayerAddition = true;
                console.error(`層追加モード検出: ${layersToAdd}層を追加`);
            }
        }
    }
    
    // 追加モードの場合、現在のモデルから現在の層数を取得
    if (isLayerAddition && currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        const currentDimensions = detectDimensionsFromModel(currentModel);
        layers = currentDimensions.layers + layersToAdd;
        console.error(`層追加: 現在${currentDimensions.layers}層 + ${layersToAdd}層 = ${layers}層`);
    } else if (!isLayerAddition) {
        // 通常の層数検出（絶対指定）
        const layerPatterns = [
            /(\d+)層/g,
            /(\d+)階/g,
            /(\d+)story/g,
            /(\d+)floor/g,
            /(\d+)\s*層/g,  // 数字と層の間にスペースがある場合
            /(\d+)\s*階/g   // 数字と階の間にスペースがある場合
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
                    console.error(`層数検出: "${match[0]}" -> 抽出された数字: "${extractedNumber}" -> ${layers}層`);
                    if (!isNaN(layers)) {
                        break;
                    }
                }
            }
        }
    }
    
    // スパン数の検出（より柔軟な検出）
    let spans = 1;
    let spansToAdd = 0; // 追加するスパン数
    
    // 「Xスパンを追加」のパターンを検出
    const addSpanPatterns = [
        /(\d+)\s*スパン\s*分*\s*(を|の)*\s*(追加|延長|増設|増築)/,  // 「2スパン分を追加」に対応
        /(追加|延長|増設|増築)\s*(\d+)\s*スパン/,
        /(右側|左側|横).*(\d+)\s*スパン\s*分*\s*(を|の)*\s*(追加|延長|増設|増築)/  // 「右側に2スパン分を追加」に対応
    ];
    
    let isSpanAddition = false;
    for (const pattern of addSpanPatterns) {
        const match = prompt.match(pattern);
        if (match) {
            const numberMatch = match[0].match(/\d+/);
            if (numberMatch) {
                spansToAdd = parseInt(numberMatch[0], 10);
                isSpanAddition = true;
                console.error(`スパン追加モード検出: ${spansToAdd}スパンを追加`);
                break;
            }
        }
    }
    
    // 追加モードの場合、現在のモデルから現在のスパン数を取得
    if (isSpanAddition && currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        const currentDimensions = detectDimensionsFromModel(currentModel);
        spans = currentDimensions.spans + spansToAdd;
        console.error(`スパン追加: 現在${currentDimensions.spans}スパン + ${spansToAdd}スパン = ${spans}スパン`);
    } else if (!isSpanAddition) {
        // 通常のスパン数検出（絶対指定）
        const spanPatterns = [
            /(\d+)スパン/g,
            /(\d+)span/g,
            /(\d+)間/g,
            /(\d+)\s*スパン/g,  // 数字とスパンの間にスペースがある場合
            /(\d+)\s*span/g     // 数字とspanの間にスペースがある場合
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
                    console.error(`スパン数検出: "${match[0]}" -> 抽出された数字: "${extractedNumber}" -> ${spans}スパン`);
                    if (!isNaN(spans)) {
                        break;
                    }
                }
            }
        }
    }
    
    // 追加モードでスパン数が検出されない場合、現在のモデルからスパン数を取得
    if ((isLayerAddition || isAddMode) && !isSpanAddition && currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        const currentDimensions = detectDimensionsFromModel(currentModel);
        spans = currentDimensions.spans;
        console.error(`層追加モードでスパン数を継承: ${spans}スパン`);
    }
    
    // スパン追加モードで層数が検出されない場合、現在のモデルから層数を取得
    if (isSpanAddition && !isLayerAddition && currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        const currentDimensions = detectDimensionsFromModel(currentModel);
        layers = currentDimensions.layers;
        console.error(`スパン追加モードで層数を継承: ${layers}層`);
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
    
    // スパン追加・層追加の検出
    const isSpanAddition = userPrompt.match(/(\d+)\s*スパン\s*分*\s*(を|の)*\s*(追加|延長|増設|増築)/) || 
                          userPrompt.match(/(右側|左側|横).*スパン/);
    const isLayerAddition = userPrompt.match(/(\d+)\s*(階|層)\s*部分\s*(を|の)*\s*(追加|延長|増設|増築)/);
    
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
        
        // スパン追加・層追加の場合の追加指示
        if (isSpanAddition || isLayerAddition) {
            const uniqueX = [...new Set(currentModel.nodes.map(n => n.x))].sort((a, b) => a - b);
            const uniqueY = [...new Set(currentModel.nodes.map(n => n.y))].sort((a, b) => a - b);
            
            editPrompt += `**【重要】既存の座標を保持してください**:\n`;
            editPrompt += `- 既存のX座標: ${uniqueX.join(', ')} m\n`;
            editPrompt += `- 既存のY座標: ${uniqueY.join(', ')} m\n`;
            
            if (isSpanAddition) {
                const maxX = Math.max(...uniqueX);
                const spanLength = uniqueX.length >= 2 ? (uniqueX[1] - uniqueX[0]) : 6;
                editPrompt += `\n**スパン追加モード**:\n`;
                editPrompt += `- 既存の全ての節点座標（上記の${currentModel.nodes.length}個の節点）はそのまま維持してください\n`;
                editPrompt += `- 新しいスパンは既存の最大X座標（${maxX} m）の右側に追加してください\n`;
                editPrompt += `- スパン長は${spanLength} m（既存のスパン長と同じ）を使用してください\n`;
                editPrompt += `- 既存のY座標（${uniqueY.join(', ')} m）の各位置に新しい節点を追加してください\n`;
                editPrompt += `- 重複する座標の節点を作成しないでください\n\n`;
            } else if (isLayerAddition) {
                const maxY = Math.max(...uniqueY);
                const storyHeight = uniqueY.length >= 2 ? (uniqueY[1] - uniqueY[0]) : 3.5;
                editPrompt += `\n**層追加モード**:\n`;
                editPrompt += `- 既存の全ての節点座標（上記の${currentModel.nodes.length}個の節点）はそのまま維持してください\n`;
                editPrompt += `- 新しい層は既存の最大Y座標（${maxY} m）の上に追加してください\n`;
                editPrompt += `- 階高は${storyHeight} m（既存の階高と同じ）を使用してください\n`;
                editPrompt += `- 既存のX座標（${uniqueX.join(', ')} m）の各位置に新しい節点を追加してください\n`;
                editPrompt += `- 重複する座標の節点を作成しないでください\n\n`;
            }
        }
    }
    
    if (currentModel && currentModel.members && currentModel.members.length > 0) {
        editPrompt += `現在の部材情報:\n`;
        currentModel.members.forEach((member, index) => {
            editPrompt += `部材${index + 1}: 節点${member.i} → 節点${member.j}`;
            if (member.name) {
                editPrompt += ` (${member.name})`;
            }
            editPrompt += `\n`;
        });
        editPrompt += `\n`;
        
        // 部材断面の統計を追加
        const memberNameStats = {};
        let verticalMembers = []; // 柱（垂直材）
        let horizontalMembers = []; // 梁（水平材）
        
        currentModel.members.forEach((member, index) => {
            const startNode = currentModel.nodes[member.i - 1];
            const endNode = currentModel.nodes[member.j - 1];
            
            if (startNode && endNode) {
                const isVertical = Math.abs(startNode.x - endNode.x) < 0.01; // X座標が同じ→垂直（柱）
                const isHorizontal = Math.abs(startNode.y - endNode.y) < 0.01; // Y座標が同じ→水平（梁）
                
                if (member.name) {
                    if (isVertical) {
                        verticalMembers.push(member.name);
                    } else if (isHorizontal) {
                        horizontalMembers.push(member.name);
                    }
                }
            }
        });
        
        // 最も多く使われている柱断面と梁断面を特定
        const getMode = (arr) => {
            if (arr.length === 0) return null;
            const counts = {};
            arr.forEach(name => counts[name] = (counts[name] || 0) + 1);
            return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
        };
        
        const columnSection = getMode(verticalMembers);
        const beamSection = getMode(horizontalMembers);
        
        if (columnSection || beamSection) {
            editPrompt += `**【重要】部材断面情報（新しい部材も同じ断面を使用してください）**:\n`;
            if (columnSection) {
                editPrompt += `- 柱（垂直材）の断面: ${columnSection}\n`;
            }
            if (beamSection) {
                editPrompt += `- 梁（水平材）の断面: ${beamSection}\n`;
            }
            editPrompt += `- 新しく追加する柱・梁についても、上記と同じ断面（name）を使用してください\n`;
            editPrompt += `- 既存の部材の断面（name）は変更しないでください\n\n`;
        }
    }
    
    // 荷重情報を追加
    if (currentModel && (currentModel.nodeLoads?.length > 0 || currentModel.memberLoads?.length > 0)) {
        editPrompt += `現在の荷重情報（必ず保持してください）:\n`;
        
        if (currentModel.nodeLoads && currentModel.nodeLoads.length > 0) {
            editPrompt += `集中荷重:\n`;
            currentModel.nodeLoads.forEach((load, index) => {
                const node = currentModel.nodes[load.n - 1];
                editPrompt += `  節点${load.n}(${node.x}, ${node.y}): px=${load.px || 0}, py=${load.py || 0}\n`;
            });
        }
        
        if (currentModel.memberLoads && currentModel.memberLoads.length > 0) {
            editPrompt += `等分布荷重:\n`;
            currentModel.memberLoads.forEach((load, index) => {
                const member = currentModel.members[load.m - 1];
                const startNode = currentModel.nodes[member.i - 1];
                const endNode = currentModel.nodes[member.j - 1];
                editPrompt += `  部材${load.m}[節点(${startNode.x},${startNode.y})→節点(${endNode.x},${endNode.y})]: w=${load.w}\n`;
            });
        }
        
        editPrompt += `\n**重要**: 上記の荷重は必ず保持してください。新しい節点・部材を追加する場合でも、既存の荷重は元の節点・部材番号で保持してください。\n\n`;
    }
    
    editPrompt += `上記の現在のモデルに対して、指示された編集を適用してください。\n\n`;
    editPrompt += `**最終確認事項（絶対に守ってください）**:\n`;
    editPrompt += `- 境界条件変更の指示がない場合は、既存の節点の境界条件（s）を必ず保持してください\n`;
    editPrompt += `- 座標変更や部材変更の指示だけで境界条件を変更することは絶対に禁止です\n`;
    editPrompt += `- 生成するJSONでは、既存の節点の境界条件（s）を元の値のまま出力してください\n`;
    editPrompt += `- 既存の荷重データ（nodeLoads, memberLoads）を必ず保持してください\n`;
    editPrompt += `- 既存の部材の断面名（name）を必ず保持してください（同じ座標の部材は同じ断面名）\n`;
    editPrompt += `- 新しく追加する部材は、既存の柱・梁と同じ断面名（name）を使用してください\n`;
    editPrompt += `- 同じ座標に複数の節点を作成しないでください（重複節点禁止）\n`;
    
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
        // 座標の型チェックと変換
        if (typeof node.x !== 'number' || typeof node.y !== 'number') {
            // 文字列の場合は数値に変換を試行
            if (typeof node.x === 'string') {
                const xNum = parseFloat(node.x);
                if (!isNaN(xNum)) {
                    node.x = xNum;
                } else {
                    errors.push(`節点${index + 1}のX座標（${node.x}）が数値に変換できません`);
                    console.error(`節点${index + 1}のX座標（${node.x}）が数値に変換できません`);
                }
            } else {
                errors.push(`節点${index + 1}のX座標が数値ではありません`);
                console.error(`節点${index + 1}のX座標が数値ではありません`);
            }
            
            if (typeof node.y === 'string') {
                const yNum = parseFloat(node.y);
                if (!isNaN(yNum)) {
                    node.y = yNum;
                } else {
                    errors.push(`節点${index + 1}のY座標（${node.y}）が数値に変換できません`);
                    console.error(`節点${index + 1}のY座標（${node.y}）が数値に変換できません`);
                }
            } else {
                errors.push(`節点${index + 1}のY座標が数値ではありません`);
                console.error(`節点${index + 1}のY座標が数値ではありません`);
            }
        }
        // 境界条件のチェック（短い形式と長い形式の両方を許容）
        const validBoundaryConditions = ['f', 'p', 'r', 'x', 'free', 'pin', 'pinned', 'roller', 'fixed', 'fix', 'hinge'];
        if (!validBoundaryConditions.includes(node.s)) {
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

// スパン数を検証する関数（ラーメン構造専用）
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
    
    // トラス構造の特徴を検出（y=0にピン"p"とローラー"r"がある場合はトラス）
    const hasPinSupport = groundNodes.some(node => node.s === 'p');
    const hasRollerSupport = groundNodes.some(node => node.s === 'r');
    if (hasPinSupport && hasRollerSupport) {
        console.error('トラス構造を検出: スパン数検証をスキップ');
        return { isValid: true, errors: [] };
    }
    
    // アーチ構造の特徴を検出（y=0に支点があり、y座標が多様な場合）
    const uniqueYValues = [...new Set(model.nodes.map(node => node.y))];
    if (groundNodes.length === 2 && uniqueYValues.length >= 3 && (hasPinSupport || hasRollerSupport)) {
        console.error('アーチ構造を検出: スパン数検証をスキップ');
        return { isValid: true, errors: [] };
    }
    
    // 梁構造の特徴を検出（y座標が全て同じ場合は梁構造）
    if (uniqueYValues.length === 1) {
        console.error('梁構造を検出: スパン数検証をスキップ');
        return { isValid: true, errors: [] };
    }
    
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
        // 実際の構造層数（地面を除く）= 節点の層数 - 1
        const actualLayers = layerNodeCounts.length - 1;
        const expectedColumnCount = (spanCount + 1) * actualLayers; // 柱は(スパン数+1)×実際の層数
        const expectedBeamCount = spanCount * actualLayers; // 梁はスパン数×実際の層数（y=0の地面には梁材なし）
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

// 荷重データ保持関数
function preserveLoadData(originalModel, generatedModel, userPrompt) {
    if (!originalModel || !generatedModel) {
        console.error('荷重保持: モデルが不足しているため、処理をスキップします');
        return generatedModel;
    }
    
    console.error('=== 荷重データ保持処理開始 ===');
    
    // 荷重変更の指示を検出
    const loadChangeKeywords = /荷重.*変更|荷重.*削除|荷重.*追加|荷重.*設定|load.*change|load.*delete|load.*add|節点.*荷重|部材.*荷重|水平荷重|鉛直荷重|等分布荷重|kN|N|荷重.*kN|荷重.*N|fx|fy|q.*=|荷重.*作用|荷重.*加える|荷重.*与える/i;
    const hasLoadChangeIntent = loadChangeKeywords.test(userPrompt);
    
    console.error('荷重変更意図検出:', hasLoadChangeIntent);
    
    // 元のモデルに荷重データがあるか確認
    const hasOriginalNodeLoads = originalModel.nodeLoads && originalModel.nodeLoads.length > 0;
    const hasOriginalMemberLoads = originalModel.memberLoads && originalModel.memberLoads.length > 0;
    
    console.error('元のモデルの荷重:', {
        nodeLoads: hasOriginalNodeLoads ? originalModel.nodeLoads.length : 0,
        memberLoads: hasOriginalMemberLoads ? originalModel.memberLoads.length : 0
    });
    
    if (hasOriginalMemberLoads) {
        console.error('元のモデルの等分布荷重詳細:', originalModel.memberLoads.map(load => {
            const member = originalModel.members[load.m - 1];
            return {
                m: load.m,
                w: load.w,
                connection: member ? `節点${member.i}→${member.j}` : '不明'
            };
        }));
    }
    
    console.error('生成されたモデルの荷重:', {
        nodeLoads: generatedModel.nodeLoads ? generatedModel.nodeLoads.length : 0,
        memberLoads: generatedModel.memberLoads ? generatedModel.memberLoads.length : 0
    });
    
    // 荷重変更の指示がある場合は、AIが生成した荷重データを使用
    if (hasLoadChangeIntent) {
        console.error('荷重変更の指示があるため、AIが生成した荷重データを使用します');
        console.error('AI生成荷重データ:', {
            nodeLoads: generatedModel.nodeLoads ? generatedModel.nodeLoads.length : 0,
            memberLoads: generatedModel.memberLoads ? generatedModel.memberLoads.length : 0
        });
        return generatedModel;
    }
    
    // 荷重変更の指示がない場合は、元の荷重データを保持
    console.error('荷重変更の指示がないため、元の荷重データを保持します');
        
        const preservedModel = JSON.parse(JSON.stringify(generatedModel));
        preservedModel.nodeLoads = [];
        preservedModel.memberLoads = [];
        
        // 集中荷重の保持（節点座標でマッピング）
        if (hasOriginalNodeLoads) {
            console.error('集中荷重のマッピング開始');
            
            originalModel.nodeLoads.forEach((load, index) => {
                // 元の節点番号から節点座標を取得
                const originalNode = originalModel.nodes[load.n - 1]; // n は1ベース
                if (!originalNode) {
                    console.error(`警告: 集中荷重${index + 1}の節点${load.n}が元のモデルに存在しません`);
                    return;
                }
                
                // 生成されたモデルで同じ座標の節点を探す
                const matchedNodeIndex = generatedModel.nodes.findIndex(node => 
                    Math.abs(node.x - originalNode.x) < 0.01 && 
                    Math.abs(node.y - originalNode.y) < 0.01
                );
                
                if (matchedNodeIndex >= 0) {
                    // マッチした節点番号で荷重を追加（0ベース→1ベース）
                    const newLoad = {
                        ...load,
                        n: matchedNodeIndex + 1
                    };
                    preservedModel.nodeLoads.push(newLoad);
                    console.error(`集中荷重マッピング: 元の節点${load.n}(${originalNode.x}, ${originalNode.y}) → 新しい節点${matchedNodeIndex + 1}`);
                } else {
                    console.error(`警告: 節点(${originalNode.x}, ${originalNode.y})が新しいモデルに見つかりません`);
                }
            });
            
            console.error(`集中荷重を保持: ${preservedModel.nodeLoads.length}/${originalModel.nodeLoads.length}個`);
        }
        
        // 等分布荷重の保持（部材接続でマッピング）
        if (hasOriginalMemberLoads) {
            console.error('等分布荷重のマッピング開始');
            
            originalModel.memberLoads.forEach((load, index) => {
                // 元の部材番号から部材接続を取得
                const originalMember = originalModel.members[load.m - 1]; // m は1ベース
                if (!originalMember) {
                    console.error(`警告: 等分布荷重${index + 1}の部材${load.m}が元のモデルに存在しません`);
                    return;
                }
                
                // 元の部材の始点と終点の座標を取得
                const originalStartNode = originalModel.nodes[originalMember.i - 1];
                const originalEndNode = originalModel.nodes[originalMember.j - 1];
                
                if (!originalStartNode || !originalEndNode) {
                    console.error(`警告: 部材${load.m}の節点が元のモデルに存在しません`);
                    return;
                }
                
                // 生成されたモデルで同じ接続の部材を探す
                // 1. 新しいモデルで始点・終点の座標に対応する節点番号を見つける
                const newStartNodeIndex = generatedModel.nodes.findIndex(node =>
                    Math.abs(node.x - originalStartNode.x) < 0.01 &&
                    Math.abs(node.y - originalStartNode.y) < 0.01
                );
                const newEndNodeIndex = generatedModel.nodes.findIndex(node =>
                    Math.abs(node.x - originalEndNode.x) < 0.01 &&
                    Math.abs(node.y - originalEndNode.y) < 0.01
                );
                
                if (newStartNodeIndex < 0 || newEndNodeIndex < 0) {
                    console.error(`警告: 部材の節点座標が新しいモデルに見つかりません`);
                    return;
                }
                
                // 2. 同じ接続を持つ部材を探す（順序は問わない）
                const matchedMemberIndex = generatedModel.members.findIndex(member =>
                    (member.i === newStartNodeIndex + 1 && member.j === newEndNodeIndex + 1) ||
                    (member.i === newEndNodeIndex + 1 && member.j === newStartNodeIndex + 1)
                );
                
                if (matchedMemberIndex >= 0) {
                    // マッチした部材番号で荷重を追加（0ベース→1ベース）
                    const newLoad = {
                        ...load,
                        m: matchedMemberIndex + 1
                    };
                    preservedModel.memberLoads.push(newLoad);
                    console.error(`等分布荷重マッピング: 元の部材${load.m}(節点${originalMember.i}→${originalMember.j}) → 新しい部材${matchedMemberIndex + 1}(節点${newStartNodeIndex + 1}→${newEndNodeIndex + 1})`);
                } else {
                    console.error(`警告: 部材接続(節点${newStartNodeIndex + 1}→${newEndNodeIndex + 1})が新しいモデルに見つかりません`);
                }
            });
            
            console.error(`等分布荷重を保持: ${preservedModel.memberLoads.length}/${originalModel.memberLoads.length}個`);
            
            if (preservedModel.memberLoads.length > 0) {
                console.error('最終的な等分布荷重配置:', preservedModel.memberLoads.map(load => {
                    const member = preservedModel.members[load.m - 1];
                    const startNode = member ? preservedModel.nodes[member.i - 1] : null;
                    const endNode = member ? preservedModel.nodes[member.j - 1] : null;
                    return {
                        m: load.m,
                        w: load.w,
                        connection: member ? `節点${member.i}(${startNode?.x},${startNode?.y})→節点${member.j}(${endNode?.x},${endNode?.y})` : '不明',
                        name: member?.name || '(なし)'
                    };
                }));
            }
        }
        
        // 部材のname（断面名）の保持（部材接続でマッピング）
        // 材料変更・断面変更の指示がない場合のみ適用
        const materialChangeKeywords = /材料.*変更|断面.*変更|弾性係数.*変更|ステンレス|アルミ|material.*change|section.*change|modulus.*change/i;
        const hasMaterialChangeIntent = materialChangeKeywords.test(userPrompt);
        
        if (!hasMaterialChangeIntent) {
            console.error('部材断面名（name）のマッピング開始（材料変更の指示なし）');
            console.error('元のモデルの部材数:', originalModel.members.length);
            console.error('元のモデルの最初の3部材:', originalModel.members.slice(0, 3).map(m => ({
                i: m.i,
                j: m.j,
                name: m.name || '(なし)'
            })));
            let memberNameMappingCount = 0;
            
            originalModel.members.forEach((originalMember, index) => {
                // 元の部材の始点と終点の座標を取得
                const originalStartNode = originalModel.nodes[originalMember.i - 1];
                const originalEndNode = originalModel.nodes[originalMember.j - 1];
                
                if (!originalStartNode || !originalEndNode) {
                    return;
                }
                
                // 生成されたモデルで同じ接続の部材を探す
                const newStartNodeIndex = generatedModel.nodes.findIndex(node =>
                    Math.abs(node.x - originalStartNode.x) < 0.01 &&
                    Math.abs(node.y - originalStartNode.y) < 0.01
                );
                const newEndNodeIndex = generatedModel.nodes.findIndex(node =>
                    Math.abs(node.x - originalEndNode.x) < 0.01 &&
                    Math.abs(node.y - originalEndNode.y) < 0.01
                );
                
                if (newStartNodeIndex < 0 || newEndNodeIndex < 0) {
                    return;
                }
                
                // 同じ接続を持つ部材を探す（順序は問わない）
                const matchedMemberIndex = preservedModel.members.findIndex(member =>
                    (member.i === newStartNodeIndex + 1 && member.j === newEndNodeIndex + 1) ||
                    (member.i === newEndNodeIndex + 1 && member.j === newStartNodeIndex + 1)
                );
                
                if (matchedMemberIndex >= 0 && originalMember.name) {
                    // マッチした部材のnameを元のモデルから復元
                    preservedModel.members[matchedMemberIndex].name = originalMember.name;
                    memberNameMappingCount++;
                    console.error(`部材断面名マッピング: 元の部材${index + 1}(${originalMember.name}) → 新しい部材${matchedMemberIndex + 1}`);
                }
            });
            
            console.error(`部材断面名を保持: ${memberNameMappingCount}/${originalModel.members.length}個`);
        } else {
            console.error('材料変更の指示が検出されたため、部材断面名のマッピングをスキップします');
        }
        
        console.error('=== 荷重データ保持処理完了 ===');
        return preservedModel;
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
            
            // 境界条件を正規化して比較・復元
            const originalCondition = normalizeBoundaryCondition(originalNode.s);
            const generatedCondition = normalizeBoundaryCondition(generatedNode.s);
            
            if (originalCondition !== generatedCondition) {
                console.error(`節点${i + 1}の境界条件を復元: ${generatedNode.s} → ${originalCondition}`);
                preservedModel.nodes[i].s = originalCondition;
                boundaryChangesDetected = true;
                boundaryChangesApplied++;
            } else if (generatedNode.s !== originalCondition) {
                // 同じ意味だが形式が異なる場合も正規化
                preservedModel.nodes[i].s = originalCondition;
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
            
            // 境界条件を正規化して比較・復元
            const originalCondition = normalizeBoundaryCondition(originalNode.s);
            const currentCondition = normalizeBoundaryCondition(currentNode.s);
            
            if (originalCondition !== currentCondition) {
                console.log(`フォールバック: 節点${i + 1}の境界条件を復元: ${currentNode.s} → ${originalCondition}`);
                restoredModel.nodes[i].s = originalCondition;
                restoredCount++;
            } else if (currentNode.s !== originalCondition) {
                // 同じ意味だが形式が異なる場合も正規化
                restoredModel.nodes[i].s = originalCondition;
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
            
            // 境界条件を正規化して復元
            const originalCondition = normalizeBoundaryCondition(originalNode.s);
            const currentCondition = normalizeBoundaryCondition(currentNode.s);
            
            if (originalCondition !== currentCondition) {
                console.log(`緊急修正: 節点${i + 1}の境界条件を強制復元: ${currentNode.s} → ${originalCondition}`);
                fixedModel.nodes[i].s = originalCondition;
                fixedCount++;
            } else {
                console.log(`緊急修正: 節点${i + 1}の境界条件は正しい: ${currentCondition}`);
                // 形式が異なる場合も正規化
                if (currentNode.s !== originalCondition) {
                    fixedModel.nodes[i].s = originalCondition;
                }
            }
        }
        
        console.log(`緊急修正: ${fixedCount}個の節点の境界条件を復元しました`);
        
        // 最終確認: 全ての境界条件が正しいかチェック（正規化して比較）
        let allCorrect = true;
        for (let i = 0; i < minLength; i++) {
            const originalCondition = normalizeBoundaryCondition(originalModel.nodes[i].s);
            const fixedCondition = normalizeBoundaryCondition(fixedModel.nodes[i].s);
            
            if (originalCondition !== fixedCondition) {
                console.error(`緊急修正エラー: 節点${i + 1}の境界条件が復元されていません: ${fixedModel.nodes[i].s} (期待値: ${originalCondition})`);
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
        
        // 境界条件を正規化して比較
        const normalizedOriginal = normalizeBoundaryCondition(originalBoundary);
        const normalizedGenerated = normalizeBoundaryCondition(generatedBoundary);
        
        if (normalizedOriginal === normalizedGenerated) {
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
    
    // 全ての境界条件を強制的に復元（正規化して短い形式に統一）
    for (let i = 0; i < minLength; i++) {
        const originalBoundary = originalModel.nodes[i].s;
        const currentBoundary = fixedModel.nodes[i].s;
        
        // 境界条件を正規化して復元（短い形式に統一）
        const normalizedBoundary = normalizeBoundaryCondition(originalBoundary);
        fixedModel.nodes[i].s = normalizedBoundary;
        
        const normalizedCurrent = normalizeBoundaryCondition(currentBoundary);
        if (normalizedBoundary !== normalizedCurrent) {
            console.log(`最終復元: 節点${i + 1}の境界条件を強制復元: ${currentBoundary} → ${normalizedBoundary}`);
            fixedCount++;
        } else {
            console.log(`最終復元: 節点${i + 1}の境界条件は正しい: ${normalizedBoundary}`);
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
        
        // 境界条件を正規化して比較
        const normalizedOriginal = normalizeBoundaryCondition(originalNode.s);
        const normalizedGenerated = normalizeBoundaryCondition(generatedNode.s);
        
        if (normalizedOriginal !== normalizedGenerated) {
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
            if (!generatedModel.nodes[index]) return false;
            const normalizedOriginal = normalizeBoundaryCondition(node.s);
            const normalizedGenerated = normalizeBoundaryCondition(generatedModel.nodes[index].s);
            return normalizedOriginal !== normalizedGenerated;
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
async function validateAndFixStructure(model, userPrompt, originalModel = null, detectedDimensions = null) {
    try {
        console.error('=== 構造検証開始 ===');
        console.error('ユーザープロンプト:', userPrompt);
        console.error('現在のモデル:', JSON.stringify(model, null, 2));
        
        let errors = [];
        let fixedModel = JSON.parse(JSON.stringify(model)); // ディープコピー
        
        // 構造の次元を検出
        // 既に検出済みの次元があればそれを使用、なければプロンプトとoriginalModelから検出
        const dimensions = detectedDimensions || detectStructureDimensions(userPrompt, originalModel);
        console.error('検出された構造次元:', dimensions);
        
        // 構造タイプを確認（元のモデルがあればそれから推定）
        const structureType = detectStructureType(userPrompt, originalModel);
        console.error('構造タイプ:', structureType);
        
        // 構造タイプ別の詳細検証を実行
        if (structureType === 'beam') {
            return validateBeamStructure(fixedModel, userPrompt);
        } else if (structureType === 'truss') {
            return validateTrussStructure(fixedModel, userPrompt);
        } else if (structureType === 'arch') {
            // アーチ構造は形状が多様なため、詳細な検証をスキップ
            console.error('アーチ構造: 詳細検証をスキップ');
            return { isValid: true, errors: [], fixedModel: fixedModel };
        } else if (structureType === 'basic') {
            // 一般構造は、AIの判断を尊重し、詳細な検証をスキップ
            console.error('一般構造: AIの判断を尊重、詳細検証をスキップ');
            return { isValid: true, errors: [], fixedModel: fixedModel };
        }
        
        // ラーメン構造かどうかを確認
        const isFrameStructure = structureType === 'frame';
        console.error('ラーメン構造:', isFrameStructure);
    
    // 門型ラーメンの場合は特別な検証を実行
    if (isFrameStructure && dimensions.isPortalFrame) {
        console.error('門型ラーメンの検証を実行');
        
        // 門型ラーメンの期待値
        const expectedNodes = 4;
        const expectedMembers = 3;
        
        console.error('期待値:', {
            isPortalFrame: true,
            expectedNodes,
            expectedMembers
        });
        
        // 構造の検証
        let needsCorrection = false;
        
        // 節点数の検証
        console.error(`節点数検証: 期待値${expectedNodes}、実際${fixedModel.nodes.length}`);
        if (fixedModel.nodes.length !== expectedNodes) {
            errors.push(`門型ラーメン節点数が不正: 期待値${expectedNodes}、実際${fixedModel.nodes.length}`);
            needsCorrection = true;
        }
        
        // 部材数の検証
        console.error(`部材数検証: 期待値${expectedMembers}、実際${fixedModel.members.length}`);
        if (fixedModel.members.length !== expectedMembers) {
            errors.push(`門型ラーメン部材数が不正: 期待値${expectedMembers}、実際${fixedModel.members.length}`);
            needsCorrection = true;
        }
        
        // 修正は行わず、エラーを返すのみ（AIに再生成させる）
        if (needsCorrection) {
            console.error('門型ラーメンの構造が不正: AIに修正を依頼');
            return {
                isValid: false,
                errors: errors,
                fixedModel: fixedModel,
                needsAICorrection: true
            };
        }
    }
    // 多層多スパンラーメンの場合は通常の検証を実行
    else if (isFrameStructure && dimensions.layers > 0 && dimensions.spans > 0) {
        console.error(`${dimensions.layers}層${dimensions.spans}スパン構造の検証を実行`);
        
        // 期待値の計算
        const expectedNodes = (dimensions.layers + 1) * (dimensions.spans + 1);
        // 柱の数: layers * (spans + 1)、梁の数: layers * spans
        const expectedMembers = dimensions.layers * (dimensions.spans + 1) + dimensions.layers * dimensions.spans;
        
        console.error('期待値:', {
            layers: dimensions.layers,
            spans: dimensions.spans,
            expectedNodes,
            expectedMembers
        });
        
        // 構造の検証
        let needsCorrection = false;
        
        // 節点数の検証（厳密）
        // スパン追加・層追加の検出（早期検出）
        const isSpanAddition = userPrompt.match(/(\d+)\s*スパン\s*分*\s*(を|の)*\s*(追加|延長|増設|増築)/) || 
                              userPrompt.match(/(右側|左側|横).*スパン/);
        const isLayerAddition = userPrompt.match(/(\d+)\s*(階|層)\s*部分\s*(を|の)*\s*(追加|延長|増設|増築)/);
        const isAdditionMode = isSpanAddition || isLayerAddition;
        
        console.error(`節点数検証: 期待値${expectedNodes}、実際${fixedModel.nodes.length}`);
        if (fixedModel.nodes.length !== expectedNodes) {
            const nodeRatio = fixedModel.nodes.length / expectedNodes;
            if (nodeRatio < 0.8) {
                // 80%未満の場合はエラー
                errors.push(`節点数が不正: 期待値${expectedNodes}、実際${fixedModel.nodes.length}`);
                needsCorrection = true;
            } else if (nodeRatio !== 1.0) {
                // 80%以上100%未満の場合は警告のみ
                console.error(`警告: 節点数が期待値と異なります（期待${expectedNodes}、実際${fixedModel.nodes.length}）が、許容範囲内です`);
            }
        }
        
        // 部材数の検証
        console.error(`部材数検証: 期待値${expectedMembers}、実際${fixedModel.members.length}`);
        if (fixedModel.members.length !== expectedMembers) {
            // 追加モードの場合は厳密にチェック
            if (isAdditionMode) {
                errors.push(`部材数が不正です。期待値: ${expectedMembers}個、実際: ${fixedModel.members.length}個`);
                needsCorrection = true;
                console.error(`追加モード検出: 部材数が期待値と一致しないため、AI修正を要求します`);
            } else {
                const memberRatio = fixedModel.members.length / expectedMembers;
                if (memberRatio < 0.7) {
                    // 70%未満の場合はエラー
                    errors.push(`部材数が不正: 期待値${expectedMembers}、実際${fixedModel.members.length}`);
                    needsCorrection = true;
                } else if (memberRatio !== 1.0) {
                    // 70%以上100%未満の場合は警告のみ
                    console.error(`警告: 部材数が期待値と異なります（期待${expectedMembers}、実際${fixedModel.members.length}）が、許容範囲内です`);
                }
            }
        }
        
        // スパン数の検証
        const spanCount = validateSpanCount(fixedModel);
        if (!spanCount.isValid) {
            // 追加モードの場合は厳格にチェック
            if (isAdditionMode) {
                errors.push(`スパン数が不正: ${spanCount.errors.join(', ')}`);
                needsCorrection = true;
                console.error(`追加モード検出: スパン数検証エラーのため、AI修正を要求します`);
            } else {
                // 編集意図が曖昧な場合は警告
                console.error(`警告: スパン数検証で問題が検出されました: ${spanCount.errors.join(', ')}`);
            }
        }
        
        // 修正が必要な場合はAIに修正指示を送る
        if (needsCorrection) {
            console.error('構造修正が必要です。AIに修正指示を送信します。');
            console.error('修正前のモデル:', JSON.stringify(fixedModel, null, 2));
            
            // 修正プロンプトを作成
            const correctionPrompt = createFrameCorrectionPrompt(userPrompt, originalModel, errors);
            console.error('修正プロンプト:', correctionPrompt);
            
            try {
                // AI修正呼び出し
                const correctionResult = await callAIWithCorrectionPrompt(correctionPrompt, 0);
                
                if (correctionResult && correctionResult.nodes && correctionResult.members) {
                    console.error(`AI修正成功 (使用プロバイダー: ${correctionResult._usedProvider || 'unknown'}, モデル: ${correctionResult._usedModel || 'unknown'}):`, {
                        nodeCount: correctionResult.nodes.length,
                        memberCount: correctionResult.members.length
                    });
                    
                    // 修正されたモデルを使用
                    fixedModel = correctionResult;
                    
                    // 荷重データを保持（元のモデルから）
                    if (originalModel) {
                        const hasOriginalNodeLoads = originalModel.nodeLoads && originalModel.nodeLoads.length > 0;
                        const hasOriginalMemberLoads = originalModel.memberLoads && originalModel.memberLoads.length > 0;
                        
                        if (hasOriginalNodeLoads || hasOriginalMemberLoads) {
                            console.error('編集モードの荷重データを保持します');
                            fixedModel = preserveLoadData(originalModel, fixedModel, userPrompt);
                        }
                    }
                    
                    errors = [`${dimensions.layers}層${dimensions.spans}スパン構造のAI修正を実行しました`];
                } else {
                    console.error('AI修正に失敗しました。元のモデルを使用します。');
                    errors.push('AI修正に失敗しました');
                }
            } catch (aiError) {
                console.error('AI修正呼び出しでエラー:', aiError);
                errors.push('AI修正呼び出しでエラーが発生しました');
            }
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
function generateCorrectFrameStructure(layers, spans, referenceModel = null) {
    try {
        console.error(`=== ${layers}層${spans}スパン構造を生成 ===`);
        
        const nodes = [];
        const members = [];
        
        // 参照モデルから実際のスパン長と階高を計算
        let spanLength = 7; // デフォルト値
        let storyHeight = 3.2; // デフォルト値
        
        if (referenceModel && referenceModel.nodes && referenceModel.nodes.length > 0) {
            // X座標のユニークな値を取得してソート
            const uniqueX = [...new Set(referenceModel.nodes.map(n => n.x))].sort((a, b) => a - b);
            if (uniqueX.length >= 2) {
                // 隣接するX座標の差を計算（スパン長）
                const xDifferences = [];
                for (let i = 1; i < uniqueX.length; i++) {
                    xDifferences.push(uniqueX[i] - uniqueX[i - 1]);
                }
                // 最小の差をスパン長とする（固定支点がある場合を考慮）
                spanLength = Math.min(...xDifferences);
                console.error(`参照モデルからスパン長を計算: ${spanLength}m`);
            }
            
            // Y座標のユニークな値を取得してソート
            const uniqueY = [...new Set(referenceModel.nodes.map(n => n.y))].sort((a, b) => a - b);
            if (uniqueY.length >= 2) {
                // 隣接するY座標の差を計算（階高）
                storyHeight = uniqueY[1] - uniqueY[0];
                console.error(`参照モデルから階高を計算: ${storyHeight}m`);
            }
        } else {
            console.error(`参照モデルがないため、デフォルト値を使用: スパン長${spanLength}m, 階高${storyHeight}m`);
        }
        
        // 節点の生成
        console.error(`節点の生成開始: ${layers + 1}層×${spans + 1}列 (スパン長${spanLength}m, 階高${storyHeight}m)`);
        for (let layer = 0; layer <= layers; layer++) {
            for (let span = 0; span <= spans; span++) {
                const x = span * spanLength;
                const y = layer * storyHeight;
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

// プロンプトから矢高（ライズ）を直接抽出する関数
function extractRiseFromPrompt(userPrompt) {
    const prompt = userPrompt.toLowerCase();
    const risePatterns = [
        /矢高(\d+(?:\.\d+)?)m/g,
        /ライズ(\d+(?:\.\d+)?)m/g,
        /rise\s*(\d+(?:\.\d+)?)m/g,
        /(\d+(?:\.\d+)?)m.*矢高/g,
        /(\d+(?:\.\d+)?)m.*ライズ/g,
        /(\d+(?:\.\d+)?)m.*rise/g
    ];
    
    for (const pattern of risePatterns) {
        const match = prompt.match(pattern);
        if (match) {
            const numberMatch = match[0].match(/\d+(?:\.\d+)?/);
            if (numberMatch) {
                const rise = parseFloat(numberMatch[0]);
                if (!isNaN(rise)) {
                    return rise;
                }
            }
        }
    }
    
    return 4.0; // デフォルト値
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
    
    let correctionPrompt = `ワーレントラス構造の修正指示:

元の指示: ${originalPrompt}

現在の生成結果に以下の問題があります:
${errors.map(error => `- ${error}`).join('\n')}

修正要求:
高さ${height}m、スパン長${spanLength}mのワーレントラス構造を生成してください

ワーレントラスの重要な特徴:
1. 垂直材を使用しない（斜材のみで構成）
2. 斜材が上向き・下向きと交互に配置（ジグザグの「W」字形状）
3. 上弦材の節点は下弦材の節点の中間位置に配置

節点配置:
- 下弦材（y=0）: スパンを等分割（例: 4パネルなら x=0, 3.75, 7.5, 11.25, 15）
- 上弦材（y=${height}）: 下弦材の中間位置（例: x=1.875, 5.625, 9.375, 13.125）
- 境界条件: 下弦材の左端（x=0,y=0）は"p"、右端（x=${spanLength},y=0）は"r"、その他は"f"

部材配置:
- 下弦材: 下弦の節点を順に接続
- 上弦材: 上弦の節点を順に接続
- 斜材: 交互に上向き・下向きに配置（垂直材は絶対に配置しない）
  * 上向き斜材: 下弦材の節点から右上の上弦材の節点へ
  * 下向き斜材: 上弦材の節点から右下の下弦材の節点へ

例: 高さ3m、スパン15mのワーレントラス（4パネル）
節点（9個）:
- 下弦材: {"x":0,"y":0,"s":"p"}, {"x":3.75,"y":0,"s":"f"}, {"x":7.5,"y":0,"s":"f"}, {"x":11.25,"y":0,"s":"f"}, {"x":15,"y":0,"s":"r"}
- 上弦材: {"x":1.875,"y":3,"s":"f"}, {"x":5.625,"y":3,"s":"f"}, {"x":9.375,"y":3,"s":"f"}, {"x":13.125,"y":3,"s":"f"}
部材（16本）:
- 下弦材: 1→2, 2→3, 3→4, 4→5
- 上弦材: 6→7, 7→8, 8→9
- 斜材（上向き）: 1→6, 2→7, 3→8, 4→9
- 斜材（下向き）: 6→2, 7→3, 8→4, 9→5

重要: この形状が「W」字のジグザグパターンを作ります。

JSON形式で出力してください。`;

    return correctionPrompt;
}

// 梁構造の修正プロンプトを作成する関数
function createBeamCorrectionPrompt(originalPrompt, currentModel, errors) {
    let correctionPrompt = `梁構造の修正指示:

元の指示: ${originalPrompt}

現在の生成結果に以下の問題があります:
${errors.map(error => `- ${error}`).join('\n')}

修正要求:`;

    if (originalPrompt.includes('キャンチレバー') || originalPrompt.includes('片持ち梁') || originalPrompt.includes('cantilever')) {
        correctionPrompt += `
1. キャンチレバー（片持ち梁）構造を生成してください
2. 左端のみ"x"（固定端）、他は全て"f"（自由端）
3. y=0の節点に"p"や"r"は禁止
4. 荷重: 自由端に集中荷重を生成（例: {"n": 2, "fy": -10}）`;
    } else {
        const dimensions = detectStructureDimensions(originalPrompt, currentModel);
        if (dimensions.spans > 1) {
            correctionPrompt += `
1. 連続梁構造を生成してください
2. 両端のみ"p"（ピン支点）、中間節点は全て"f"（自由端）
3. y=0の節点に"x"や"r"は禁止
4. 節点数: ${dimensions.spans + 1}個以上
5. 部材数: ${dimensions.spans}個以上`;
        } else {
            correctionPrompt += `
1. 単純梁構造を生成してください
2. 両端のみ"p"（ピン支点）、中間節点は全て"f"（自由端）
3. y=0の節点に"x"や"r"は禁止
4. 節点数: 2個以上
5. 部材数: 1個以上`;
        }
    }

    correctionPrompt += `

重要: 節点番号・部材番号は必ず1から開始（配列のインデックス+1）、0は絶対に使用禁止
部材配置: 同じ節点間には1本の部材のみ配置（重複禁止）

JSON形式で出力してください。`;

    return correctionPrompt;
}

// ラーメン構造（門型含む）の修正プロンプトを作成する関数
function createFrameCorrectionPrompt(originalPrompt, currentModel, errors) {
    const dimensions = detectStructureDimensions(originalPrompt, currentModel);
    
    // 門型ラーメンの場合
    if (dimensions.isPortalFrame) {
        const height = extractHeightFromPrompt(originalPrompt);
        const spanLength = extractSpanLengthFromPrompt(originalPrompt);
        
        let correctionPrompt = `門型ラーメン構造の修正指示:

元の指示: ${originalPrompt}

現在の生成結果に以下の問題があります:
${errors.map(error => `- ${error}`).join('\n')}

修正要求:
1. 門型ラーメン（ポータルフレーム）構造を生成してください
2. 高さ${height}m、スパン長${spanLength}m
3. 節点は4個のみ: 左柱脚、左柱頭、右柱頭、右柱脚
4. 部材は3本のみ: 左柱、梁、右柱
5. 節点配置:
   - 節点1: (x=0, y=0, s="x") - 左柱脚（固定支点）
   - 節点2: (x=0, y=${height}, s="f") - 左柱頭（自由）
   - 節点3: (x=${spanLength}, y=${height}, s="f") - 右柱頭（自由）
   - 節点4: (x=${spanLength}, y=0, s="x") - 右柱脚（固定支点）
6. 部材配置:
   - 部材1: i=1, j=2 (左柱)
   - 部材2: i=2, j=3 (梁)
   - 部材3: i=3, j=4 (右柱)

重要: 4節点、3部材のみで構成してください。追加の節点や部材を作成しないでください。

JSON形式で出力してください。`;

        return correctionPrompt;
    }
    
    // 多層多スパンラーメンの場合
    const expectedNodes = (dimensions.layers + 1) * (dimensions.spans + 1);
    const expectedColumns = dimensions.layers * (dimensions.spans + 1);
    const expectedBeams = dimensions.layers * dimensions.spans;
    const expectedMembers = expectedColumns + expectedBeams;
    
    // スパン追加・層追加の検出
    const isSpanAddition = originalPrompt.match(/(\d+)\s*スパン\s*分*\s*(を|の)*\s*(追加|延長|増設|増築)/);
    const isLayerAddition = originalPrompt.match(/(\d+)\s*(階|層)\s*部分\s*(を|の)*\s*(追加|延長|増設|増築)/);
    
    // 現在のモデルから実際の部材配置を分析
    let missingMembersDetail = '';
    if (currentModel && currentModel.members) {
        const actualMemberCount = currentModel.members.length;
        const missingCount = expectedMembers - actualMemberCount;
        
        if (missingCount > 0) {
            // 既存の部材接続を分析
            const existingConnections = new Set();
            currentModel.members.forEach(m => {
                existingConnections.add(`${m.i}-${m.j}`);
                existingConnections.add(`${m.j}-${m.i}`);
            });
            
            // 期待される全ての接続を列挙
            const missingConnections = [];
            
            // 柱の接続をチェック
            for (let col = 1; col <= dimensions.spans + 1; col++) {
                for (let floor = 0; floor < dimensions.layers; floor++) {
                    const lowerNode = floor * (dimensions.spans + 1) + col;
                    const upperNode = (floor + 1) * (dimensions.spans + 1) + col;
                    if (!existingConnections.has(`${lowerNode}-${upperNode}`) && 
                        !existingConnections.has(`${upperNode}-${lowerNode}`)) {
                        missingConnections.push(`柱: 節点${lowerNode}→節点${upperNode}`);
                    }
                }
            }
            
            // 梁の接続をチェック
            for (let floor = 1; floor <= dimensions.layers; floor++) {
                for (let span = 1; span <= dimensions.spans; span++) {
                    const leftNode = floor * (dimensions.spans + 1) + span;
                    const rightNode = floor * (dimensions.spans + 1) + span + 1;
                    if (!existingConnections.has(`${leftNode}-${rightNode}`) && 
                        !existingConnections.has(`${rightNode}-${leftNode}`)) {
                        missingConnections.push(`梁: 節点${leftNode}→節点${rightNode}`);
                    }
                }
            }
            
            if (missingConnections.length > 0) {
                missingMembersDetail = `\n\n【不足している部材の詳細】\n現在${actualMemberCount}個の部材がありますが、${expectedMembers}個必要です。\n以下の${missingConnections.length}個の部材が不足しています:\n${missingConnections.slice(0, 10).map(c => `- ${c}`).join('\n')}`;
                if (missingConnections.length > 10) {
                    missingMembersDetail += `\n... 他${missingConnections.length - 10}個`;
                }
                missingMembersDetail += `\n\n上記の部材を必ず追加してください。`;
            }
        }
    }
    
    let correctionPrompt = `ラーメン構造の修正指示:

元の指示: ${originalPrompt}

現在の生成結果に以下の問題があります:
${errors.map(error => `- ${error}`).join('\n')}${missingMembersDetail}

修正要求:
1. ${dimensions.layers}層${dimensions.spans}スパンのラーメン構造を生成してください
2. 節点数: ${expectedNodes}個（${dimensions.layers + 1}層×${dimensions.spans + 1}列）
3. 部材数: ${expectedMembers}個（柱${expectedColumns}本+梁${expectedBeams}本）
4. 境界条件: 地面節点（y=0）は"x"、上部節点は"f"
5. 部材配置: 
   - 柱: 各柱通りに下から上へ連続的に配置（全${expectedColumns}本）
   - 梁: 各層で水平方向に配置（全${expectedBeams}本）
   - 重要: y=0の地面には梁材（水平材）を配置しない
   - 重要: 全ての柱通り（${dimensions.spans + 1}通り）に、全ての階（${dimensions.layers}階分）の柱を配置すること`;
    
    // 元のモデルがある場合（編集モード）、既存の座標情報を追加
    if (currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        // 既存のモデルの座標情報を抽出
        const uniqueX = [...new Set(currentModel.nodes.map(n => n.x))].sort((a, b) => a - b);
        const uniqueY = [...new Set(currentModel.nodes.map(n => n.y))].sort((a, b) => a - b);
        
        correctionPrompt += `

【重要】既存のモデルから拡張する場合の制約:
既存の節点座標:
- X座標: ${uniqueX.join(', ')} m
- Y座標: ${uniqueY.join(', ')} m
- スパン長: 既存モデルのスパン長（${uniqueX.length > 1 ? uniqueX[1] - uniqueX[0] : 8} m）を使用（ユーザー指定のスパン長は無視）`;
        
        if (isSpanAddition) {
            correctionPrompt += `
- スパン追加モード: 既存のY座標（${uniqueY.join(', ')} m）を維持し、既存の最大X座標（${Math.max(...uniqueX)} m）の右側に新しいスパンを追加
- 既存の節点位置は変更しないこと`;
        } else if (isLayerAddition) {
            correctionPrompt += `
- 層追加モード: 既存のX座標（${uniqueX.join(', ')} m）を維持し、既存の最大Y座標（${Math.max(...uniqueY)} m）の上に新しい層を追加
- 既存の節点位置は変更しないこと`;
        }
        
        // スパン長と階高を元のモデルから計算
        if (uniqueX.length >= 2) {
            const spanLength = uniqueX[1] - uniqueX[0];
            correctionPrompt += `
- スパン長: ${spanLength} m（既存のモデルと同じ）`;
        }
        if (uniqueY.length >= 2) {
            const storyHeight = uniqueY[1] - uniqueY[0];
            correctionPrompt += `
- 階高: ${storyHeight} m（既存のモデルと同じ）`;
        }
    }
   
    // 具体例を追加（現在の構造に合わせて）
    if (dimensions.layers === 3 && dimensions.spans === 2) {
        correctionPrompt += `

【3層2スパンの完全な例】
節点: 12個（4行×3列）
- 地面（Y=0）: 節点1(0,0,x), 節点2(6,0,x), 節点3(12,0,x)
- 1階（Y=3.5）: 節点4(0,3.5,f), 節点5(6,3.5,f), 節点6(12,3.5,f)
- 2階（Y=7）: 節点7(0,7,f), 節点8(6,7,f), 節点9(12,7,f)
- 3階（Y=10.5）: 節点10(0,10.5,f), 節点11(6,10.5,f), 節点12(12,10.5,f)

部材: 15本（柱9本+梁6本）
柱（9本、垂直方向）:
- 左柱通り: 1→4, 4→7, 7→10
- 中柱通り: 2→5, 5→8, 8→11
- 右柱通り: 3→6, 6→9, 9→12
梁（6本、水平方向）:
- 1階: 4→5, 5→6
- 2階: 7→8, 8→9
- 3階: 10→11, 11→12

重要: 上記のように全ての柱（3通り×3階分=9本）と全ての梁（3階×2スパン=6本）を必ず配置してください。`;
    } else if (dimensions.layers === 3 && dimensions.spans === 4) {
        correctionPrompt += `

【3層4スパンの完全な例】
節点: 20個（4行×5列）、節点番号は1から20まで（0は使用禁止、必ず整数）
- 地面（Y=0）: 節点1～5（X=0,8,16,24,32）、全て境界条件"x"
- 1階（Y=4）: 節点6～10（X=0,8,16,24,32）、全て境界条件"f"
- 2階（Y=8）: 節点11～15（X=0,8,16,24,32）、全て境界条件"f"
- 3階（Y=12）: 節点16～20（X=0,8,16,24,32）、全て境界条件"f"

部材: 27本（柱15本+梁12本）、部材番号は1から27まで（0は使用禁止、必ず整数）
柱（15本、垂直方向、5通り×3階分）:
- 1通り目（X=0）: 1→6, 6→11, 11→16
- 2通り目（X=8）: 2→7, 7→12, 12→17
- 3通り目（X=16）: 3→8, 8→13, 13→18
- 4通り目（X=24）: 4→9, 9→14, 14→19
- 5通り目（X=32）: 5→10, 10→15, 15→20
梁（12本、水平方向、3階×4スパン）:
- 1階（Y=4）: 6→7, 7→8, 8→9, 9→10
- 2階（Y=8）: 11→12, 12→13, 13→14, 14→15
- 3階（Y=12）: 16→17, 17→18, 18→19, 19→20

重要: 上記のように全ての柱（5通り×3階分=15本）と全ての梁（3階×4スパン=12本）を必ず配置してください。
各柱通りには3本の柱が必要です。各階には4本の梁が必要です。

【部材生成の重要ポイント】
- 柱は各柱通り（X=0,8,16,24,32）に3本ずつ、合計15本必要
- 梁は各階（Y=4,8,12）に4本ずつ、合計12本必要
- 部材番号は1から27まで連続で使用（0は使用禁止、必ず整数）
- 同じ節点間には1本の部材のみ配置（重複禁止）
- 全ての部材に同じ断面性能（E=205000, I=0.00011, A=0.005245, Z=0.000638）を設定`;
    }
    
    correctionPrompt += `

JSON形式で出力してください。`;

    return correctionPrompt;
}

// AIに修正プロンプトで再呼び出しを行う関数（改善版）
async function callAIWithCorrectionPrompt(correctionPrompt, retryCount) {
    const maxCorrectionRetries = 2; // 修正呼び出しのリトライ回数を制限
    let correctionRetryCount = 0;
    
    while (correctionRetryCount <= maxCorrectionRetries) {
        try {
            console.error(`=== AI修正呼び出し開始 (試行 ${correctionRetryCount + 1}/${maxCorrectionRetries + 1}) ===`);
            
            // 修正API用のAPI設定（容量制限エラー時に自動切り替え）
            let API_KEY = process.env.GROQ_API_KEY;
            let API_URL = 'https://api.groq.com/openai/v1/chat/completions';
            let apiProvider = 'groq';
            
            // 修正用の最適化されたシステムプロンプト
            const systemPrompt = `2D構造モデル生成。JSON出力のみ。

形式: {"nodes": [{"x": X, "y": Y, "s": 境界条件}], "members": [{"i": 始点, "j": 終点, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638, "name": "断面名称"}], "nodeLoads": [{"n": 節点番号, "fx": 水平力, "fy": 鉛直力}], "memberLoads": [{"m": 部材番号, "q": 等分布荷重}]}

基本ルール:
- 境界条件: "f"(自由), "p"(ピン), "r"(ローラー), "x"(固定)
- 節点番号: 配列順序（1から開始、0は使用禁止、必ず整数）
- 部材番号: 配列順序（1から開始、0は使用禁止、必ず整数）
- 座標: メートル単位で小数点以下1桁まで、必ず数値型で指定（文字列禁止）
- 荷重単位: kN（キロニュートン）で指定された場合はそのまま使用、N（ニュートン）の場合は1000で割る
- 部材name: 指定された断面名称を必ず含める（例: "H-200×100×8×12"、"H-588×300×12×20"など）
- 断面性能値は上記の【鋼材】セクションの値を正確に使用
- H-200×200×8×12の場合: I=0.0472, A=0.006353, Z=0.00472
- H-588×300×12×20の場合: I=1.14, A=0.01872, Z=0.00389

重要: 鋼材断面情報が提供されている場合
- 部材のnameフィールドには「- 指定断面: 」に続く値を使用
- 柱部材と梁部材で異なる断面を適切に割り当て
- 部材のI、A、Zの値は提供された断面性能値を正確に使用
- 断面性能値は【鋼材】セクションに記載されている値をそのまま使用

重要制約:
- 同じ節点間には1本の部材のみ配置（重複禁止）
- 節点番号・部材番号は必ず1から開始（配列のインデックス+1）
- 存在しない節点番号を部材で参照しない`;

            // 修正API用のモデル設定（容量制限エラー時に自動切り替え）
            let correctionModel = "llama-3.3-70b-versatile";
            let correctionModelSwitched = false;
            
            const requestBody = {
                model: correctionModel,
                messages: [
                    { "role": "system", "content": systemPrompt },
                    { "role": "user", "content": correctionPrompt }
                ],
                response_format: { "type": "json_object" },
                temperature: 0.3, // 修正時は低い温度で一貫性を重視
                max_tokens: 4000 // トークン数を制限
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000); // 45秒タイムアウト

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
                if (response.status === 429 && correctionRetryCount < maxCorrectionRetries) {
                    console.error(`修正API容量制限エラー検出 (試行 ${correctionRetryCount + 1}/${maxCorrectionRetries + 1}) - 現在のプロバイダー: ${apiProvider}`);
                    
                    // まだモデルを切り替えていない場合、llama-3.1-8b-instantに切り替え
                    if (!correctionModelSwitched && correctionModel === "llama-3.3-70b-versatile") {
                        console.error('🔄 修正API容量制限のため、モデルをllama-3.1-8b-instantに切り替えます');
                        correctionModel = "llama-3.1-8b-instant";
                        correctionModelSwitched = true;
                        requestBody.model = correctionModel;
                        
                        // モデル切り替え後は即座に再試行
                        correctionRetryCount++;
                        continue;
                    }
                    
                    // llama-3.1-8b-instantでも容量制限の場合、Mistral APIに切り替え
                    if (apiProvider === 'groq' && correctionModel === "llama-3.1-8b-instant") {
                        console.error('🔄 修正API Groq容量制限のため、Mistral APIに切り替えます');
                        
                        // Mistral APIに切り替え
                        const mistralApiKey = process.env.MISTRAL_API_KEY;
                        if (!mistralApiKey) {
                            console.error('❌ 修正API用Mistral APIキーが設定されていません');
                            throw new Error("Mistral APIキーがサーバーに設定されていません。容量制限回避のためMistral APIへの切り替えができません。");
                        }
                        
                        API_KEY = mistralApiKey;
                        API_URL = 'https://api.mistral.ai/v1/chat/completions';
                        apiProvider = 'mistral';
                        correctionModel = "mistral-large-latest";
                        requestBody.model = correctionModel;
                        
                        console.error('✅ 修正API Mistral APIに切り替え完了');
                        
                        // API切り替え後は即座に再試行
                        correctionRetryCount++;
                        continue;
                    }
                    
                    // 容量制限の場合は待機してリトライ
                    const waitTime = 2000 + (correctionRetryCount * 1000);
                    console.error(`修正呼び出し容量制限: ${waitTime}ms待機後にリトライ`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    correctionRetryCount++;
                    continue;
                }
                throw new Error(`AI修正呼び出し失敗: ${response.status}`);
            }

            const data = await response.json();
            
            if (!data.choices || !data.choices[0] || !data.choices[0].message.content) {
                throw new Error("AI修正から予期しない形式のレスポンス");
            }

            const correctedText = data.choices[0].message.content;
            const correctedModel = JSON.parse(correctedText);
            
            // 修正後のモデルの基本検証
            if (!correctedModel.nodes || !correctedModel.members) {
                throw new Error("修正後のモデルに節点または部材データが不足");
            }
            
            console.error(`AI修正呼び出し成功 (使用プロバイダー: ${apiProvider}, モデル: ${correctionModel})`);
            console.error('修正後のモデル:', {
                nodeCount: correctedModel.nodes.length,
                memberCount: correctedModel.members.length
            });
            
            // モデル情報を含めて返す
            return {
                ...correctedModel,
                _usedModel: correctionModel,
                _usedProvider: apiProvider
            };
            
        } catch (error) {
            console.error(`AI修正呼び出しエラー (試行 ${correctionRetryCount + 1}):`, error.message);
            
            if (correctionRetryCount < maxCorrectionRetries) {
                const waitTime = 1000 + (correctionRetryCount * 500);
                console.error(`${waitTime}ms待機後にリトライ`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                correctionRetryCount++;
                continue;
            }
            
            console.error('AI修正呼び出し失敗: 最大リトライ回数に達しました');
            return null;
        }
    }
}

// 梁構造の詳細検証関数
function validateBeamStructure(model, userPrompt) {
    try {
        console.error('=== 梁構造詳細検証開始 ===');
        
        const errors = [];
        let fixedModel = JSON.parse(JSON.stringify(model));
        
        // 基本構造の検証
        if (!fixedModel.nodes || fixedModel.nodes.length < 2) {
            errors.push(`梁構造の節点が不足: ${fixedModel.nodes?.length || 0}個（最低2個必要）`);
        }
        
        if (!fixedModel.members || fixedModel.members.length < 1) {
            errors.push(`梁構造の部材が不足: ${fixedModel.members?.length || 0}個（最低1個必要）`);
        }
        
        // キャンチレバー（片持ち梁）の検証
        if (userPrompt.includes('キャンチレバー') || userPrompt.includes('片持ち梁') || userPrompt.includes('cantilever')) {
            console.error('キャンチレバー構造の検証を実行');
            
            // 固定端の検証
            const fixedNodes = fixedModel.nodes.filter(node => node.s === 'x');
            if (fixedNodes.length !== 1) {
                errors.push(`キャンチレバーの固定端が不正: ${fixedNodes.length}個（1個である必要）`);
            }
            
            // 自由端の検証
            const freeNodes = fixedModel.nodes.filter(node => node.s === 'f');
            if (freeNodes.length < 1) {
                errors.push(`キャンチレバーの自由端が不足: ${freeNodes.length}個（最低1個必要）`);
            }
            
            // y=0の節点に支点がないかチェック
            const groundNodes = fixedModel.nodes.filter(node => node.y === 0);
            const groundSupports = groundNodes.filter(node => node.s === 'p' || node.s === 'r');
            if (groundSupports.length > 0) {
                errors.push(`キャンチレバーでy=0の節点に支点が配置されています。y=0の節点に支点を配置しないでください`);
            }
        } else {
            // 連続梁・単純梁の検証
            const pinNodes = fixedModel.nodes.filter(node => node.s === 'p');
            const freeNodes = fixedModel.nodes.filter(node => node.s === 'f');
            
            if (pinNodes.length < 2) {
                errors.push(`梁構造のピン支点が不足: ${pinNodes.length}個（最低2個必要）`);
            }
            
            if (freeNodes.length < 1) {
                errors.push(`梁構造の自由節点が不足: ${freeNodes.length}個（最低1個必要）`);
            }
            
            // y=0の節点に支点がないかチェック
            const groundNodes = fixedModel.nodes.filter(node => node.y === 0);
            const groundSupports = groundNodes.filter(node => node.s === 'p' || node.s === 'r' || node.s === 'x');
            if (groundSupports.length > 0) {
                errors.push(`梁構造でy=0の節点に支点が配置されています。梁構造ではy=0の節点に支点を配置しないでください`);
            }
        }
        
        // 部材の連続性チェック
        if (fixedModel.members && fixedModel.members.length > 0) {
            const nodeConnections = new Map();
            fixedModel.members.forEach(member => {
                if (!nodeConnections.has(member.i)) nodeConnections.set(member.i, []);
                if (!nodeConnections.has(member.j)) nodeConnections.set(member.j, []);
                nodeConnections.get(member.i).push(member.j);
                nodeConnections.get(member.j).push(member.i);
            });
            
            // 孤立節点のチェック
            fixedModel.nodes.forEach((node, index) => {
                const nodeNum = index + 1;
                if (!nodeConnections.has(nodeNum) || nodeConnections.get(nodeNum).length === 0) {
                    errors.push(`節点${nodeNum}が部材に接続されていません（孤立節点）`);
                }
            });
        }
        
        console.error('梁構造詳細検証結果:', {
            isValid: errors.length === 0,
            errors: errors,
            nodeCount: fixedModel.nodes.length,
            memberCount: fixedModel.members.length
        });
        
        return {
            isValid: errors.length === 0,
            errors: errors,
            fixedModel: fixedModel
        };
        
    } catch (error) {
        console.error('validateBeamStructure関数でエラーが発生しました:', error);
        return {
            isValid: true,
            errors: [],
            fixedModel: model
        };
    }
}

// トラス構造の詳細検証関数
function validateTrussStructure(model, userPrompt) {
    try {
        console.error('=== トラス構造詳細検証開始 ===');
        
        const errors = [];
        let fixedModel = JSON.parse(JSON.stringify(model));
        
        // 基本構造の検証
        if (!fixedModel.nodes || fixedModel.nodes.length < 4) {
            errors.push(`トラス構造の節点が不足: ${fixedModel.nodes?.length || 0}個（最低4個必要）`);
        }
        
        if (!fixedModel.members || fixedModel.members.length < 3) {
            errors.push(`トラス構造の部材が不足: ${fixedModel.members?.length || 0}個（最低3個必要）`);
        }
        
        // 高さとスパン長を検出
        const height = extractHeightFromPrompt(userPrompt);
        const spanLength = extractSpanLengthFromPrompt(userPrompt);
        
        // 下弦材・上弦材の検証
        const bottomNodes = fixedModel.nodes.filter(node => node.y === 0);
        const topNodes = fixedModel.nodes.filter(node => node.y === height);
        
        if (bottomNodes.length < 2) {
            errors.push(`下弦材の節点が不足: ${bottomNodes.length}個（最低2個必要）`);
        }
        
        if (topNodes.length < 2) {
            errors.push(`上弦材の節点が不足: ${topNodes.length}個（最低2個必要）`);
        }
        
        // 境界条件の検証（支点はy=0の下弦材に配置）
        const leftNode = fixedModel.nodes.find(node => node.x === 0 && node.y === 0);
        const rightNode = fixedModel.nodes.find(node => node.x === spanLength && node.y === 0);
        
        if (!leftNode) {
            errors.push(`下弦材の左端節点（x=0,y=0）が見つかりません`);
        } else if (leftNode.s !== 'p') {
            errors.push(`下弦材の左端節点の境界条件が不正: ${leftNode.s}（"p"である必要）`);
        }
        
        if (!rightNode) {
            errors.push(`下弦材の右端節点（x=${spanLength},y=0）が見つかりません`);
        } else if (rightNode.s !== 'r') {
            errors.push(`下弦材の右端節点の境界条件が不正: ${rightNode.s}（"r"である必要）`);
        }
        
        // 上弦材に支点が配置されていないかチェック
        const topNodesWithSupport = fixedModel.nodes.filter(node => 
            node.y === height && (node.s === 'p' || node.s === 'r' || node.s === 'x')
        );
        
        if (topNodesWithSupport.length > 0) {
            errors.push(`上弦材（y=${height}）に支点が配置されています。支点は下弦材（y=0）のみに配置してください`);
        }
        
        // トラス構造の幾何学的整合性チェック
        if (fixedModel.members && fixedModel.members.length > 0) {
            // 部材の重複チェック
            const memberSet = new Set();
            fixedModel.members.forEach(member => {
                const key = member.i < member.j ? `${member.i}-${member.j}` : `${member.j}-${member.i}`;
                if (memberSet.has(key)) {
                    errors.push(`重複部材が検出されました: 節点${member.i}-${member.j}`);
                }
                memberSet.add(key);
            });
            
            // 節点の接続性チェック
            const nodeConnections = new Map();
            fixedModel.members.forEach(member => {
                if (!nodeConnections.has(member.i)) nodeConnections.set(member.i, []);
                if (!nodeConnections.has(member.j)) nodeConnections.set(member.j, []);
                nodeConnections.get(member.i).push(member.j);
                nodeConnections.get(member.j).push(member.i);
            });
            
            // 孤立節点のチェック
            fixedModel.nodes.forEach((node, index) => {
                const nodeNum = index + 1;
                if (!nodeConnections.has(nodeNum) || nodeConnections.get(nodeNum).length === 0) {
                    errors.push(`節点${nodeNum}が部材に接続されていません（孤立節点）`);
                }
            });
        }
        
        console.error('トラス構造詳細検証結果:', {
            isValid: errors.length === 0,
            errors: errors,
            nodeCount: fixedModel.nodes.length,
            memberCount: fixedModel.members.length
        });
        
        return {
            isValid: errors.length === 0,
            errors: errors,
            fixedModel: fixedModel
        };
        
    } catch (error) {
        console.error('validateTrussStructure関数でエラーが発生しました:', error);
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