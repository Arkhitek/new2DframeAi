// 外部と通信するための道具をインポートします
const fetch = require('node-fetch');

// Vercelのサーバーレス関数のエントリーポイント
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    try {
        const { prompt: userPrompt, mode = 'new', currentModel } = req.body;
        if (!userPrompt) {
            res.status(400).json({ error: '指示内容が空です。' });
            return;
        }

        const API_KEY = process.env.MISTRAL_API_KEY;
        if (!API_KEY) {
            throw new Error("Mistral AIのAPIキーがサーバーに設定されていません。");
        }
        
        const API_URL = 'https://api.mistral.ai/v1/chat/completions';
        
        const systemPrompt = createSystemPromptForBackend(mode, currentModel);
        
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

        const mistralResponse = await fetch(API_URL, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(requestBody),
        });

        const data = await mistralResponse.json();

        if (!mistralResponse.ok) {
            console.error('Mistral AI Error:', data);
            throw new Error(data.message || 'Mistral AIでエラーが発生しました。');
        }

        if (!data.choices || !data.choices[0] || !data.choices[0].message.content) {
             throw new Error("Mistral AIから予期しない形式のレスポンスがありました。");
        }
        const generatedText = data.choices[0].message.content;

        // 生成されたモデルの検証
        try {
            const generatedModel = JSON.parse(generatedText);
            
            // 新規作成・編集両方で節点参照を検証
            const nodeReferenceValidation = validateNodeReferences(generatedModel);
            if (!nodeReferenceValidation.isValid) {
                console.error('節点参照エラー:', nodeReferenceValidation.errors);
                throw new Error(`節点参照エラー: ${nodeReferenceValidation.errors.join(', ')}`);
            }
            
            // 編集モードの場合、境界条件の保持を検証
            if (mode === 'edit' && currentModel) {
                const boundaryChangeIntent = detectBoundaryChangeIntent(userPrompt);
                const validationResult = validateBoundaryConditions(currentModel, generatedModel, boundaryChangeIntent);
                if (!validationResult.isValid) {
                    console.warn('境界条件保持の警告:', validationResult.warnings);
                    // 警告は出しますが、レスポンスは返します
                }
            }
        } catch (parseError) {
            console.warn('生成されたモデルの解析エラー:', parseError);
            // JSON解析エラーでもレスポンスは返します
        }

        const responseForFrontend = {
            candidates: [{
                content: {
                    parts: [{
                        text: generatedText
                    }]
                }
            }]
        };

        res.status(200).json(responseForFrontend);

    } catch (error) {
        console.error('サーバーレス関数エラー:', error);
        res.status(500).json({ error: error.message });
    }
}

function createSystemPromptForBackend(mode = 'new', currentModel = null) {
    let prompt = `
あなたは2Dフレーム構造解析モデルを生成する専門のアシスタントです。`;

    if (mode === 'edit') {
        prompt += `
現在のモデル情報を基に、ユーザーの編集指示に従ってモデルを更新してください。
既存の構造を保持しつつ、指示された変更のみを適用してください。`;
    } else {
        prompt += `
ユーザーからの自然言語による指示に基づいて、新しい構造モデルを作成してください。`;
    }

    prompt += `
以下のJSON形式で構造モデルデータを出力してください。
JSONデータのみを出力し、前後の説明やマークダウンの\`\`\`json ... \`\`\`は含めないでください。

**JSONデータ構造の例:**

**単純な2節点構造:**
\`\`\`json
{
  "nodes": [
    {"x": 0, "y": 0, "s": "x"},
    {"x": 8, "y": 0, "s": "x"}
  ],
  "members": [
    {"i": 1, "j": 2, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}
  ]
}
\`\`\`

**2層2スパンラーメン構造の例:**
\`\`\`json
{
  "nodes": [
    {"x": 0, "y": 0, "s": "x"},
    {"x": 6, "y": 0, "s": "x"},
    {"x": 0, "y": 4, "s": "f"},
    {"x": 6, "y": 4, "s": "f"}
  ],
  "members": [
    {"i": 1, "j": 3, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 2, "j": 4, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 3, "j": 4, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}
  ]
}
\`\`\`
**上記例の解説:**
- 節点1: (0,0) - 1層左柱脚（固定）
- 節点2: (6,0) - 1層右柱脚（固定）
- 節点3: (0,4) - 2層左柱頭（自由）
- 節点4: (6,4) - 2層右柱頭（自由）
- 部材1: 節点1→節点3（左柱）
- 部材2: 節点2→節点4（右柱）
- 部材3: 節点3→節点4（梁）
- **重要**: 節点番号は配列の順序で決まり、部材は必ず存在する節点のみを参照

**3層3スパンラーメン構造の例（正しい例）:**
\`\`\`json
{
  "nodes": [
    {"x": 0, "y": 0, "s": "x"},
    {"x": 6, "y": 0, "s": "x"},
    {"x": 12, "y": 0, "s": "x"},
    {"x": 18, "y": 0, "s": "x"},
    {"x": 0, "y": 4, "s": "f"},
    {"x": 6, "y": 4, "s": "f"},
    {"x": 12, "y": 4, "s": "f"},
    {"x": 18, "y": 4, "s": "f"},
    {"x": 0, "y": 8, "s": "f"},
    {"x": 6, "y": 8, "s": "f"},
    {"x": 12, "y": 8, "s": "f"},
    {"x": 18, "y": 8, "s": "f"},
    {"x": 0, "y": 12, "s": "f"},
    {"x": 6, "y": 12, "s": "f"},
    {"x": 12, "y": 12, "s": "f"},
    {"x": 18, "y": 12, "s": "f"}
  ],
  "members": [
    {"i": 1, "j": 5, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 2, "j": 6, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 3, "j": 7, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 4, "j": 8, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 5, "j": 9, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 6, "j": 10, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 7, "j": 11, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 8, "j": 12, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 9, "j": 13, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 10, "j": 14, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 11, "j": 15, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 12, "j": 16, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 5, "j": 6, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 6, "j": 7, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 7, "j": 8, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 9, "j": 10, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 10, "j": 11, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 11, "j": 12, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 13, "j": 14, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 14, "j": 15, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638},
    {"i": 15, "j": 16, "E": 205000, "I": 0.00011, "A": 0.005245, "Z": 0.000638}
  ]
}
\`\`\`
**3層3スパン例の解説（重要）:**
- **スパン数の理解**: 3スパン = 4本の柱が必要（左端、中間2本、右端）
- **節点数**: (3スパン+1)×4層 = 4×4 = 16節点
- **部材数**: 4×4層（柱）+ 4層×3スパン（梁）= 16 + 12 = 21部材
- **節点配置**: 1層(0,0)(6,0)(12,0)(18,0)、2層(0,4)(6,4)(12,4)(18,4)、3層(0,8)(6,8)(12,8)(18,8)、4層(0,12)(6,12)(12,12)(18,12)
- **柱配置**: 各層に4本の柱（X座標: 0, 6, 12, 18）を配置
- **梁配置**: 各層に3本の梁（柱間を接続）
- **絶対に間違えないでください**: 3スパンには必ず4本の柱が必要です

**各キーの詳細説明:**
- **nodes**: 節点の配列
  - \`x\`: X座標 (単位: m)
  - \`y\`: Y座標 (単位: m)
  - \`s\`: 境界条件。文字列で "f" (自由), "p" (ピン), "r" (ローラー), "x" (固定) のいずれか。
- **members**: 部材の配列
  - \`i\`, \`j\`: 始点と終点の節点番号 (1から始まる整数)。
  - \`E\`: ヤング係数 (単位: N/mm²)。指定がなければ鋼材の \`205000\` を使用。
  - \`A\`: 断面積 (単位: m²)。
  - \`I\`: 断面二次モーメント (単位: m⁴)。
  - \`Z\`: 断面係数 (単位: m³)。
  - \`i_conn\`, \`j_conn\`: 接合条件。"rigid" (剛接合) または "pinned" (ピン接合)。指定がなければ "rigid" とする。
  - **重要**: 部材は配列の順序で識別されます。1番目の部材、2番目の部材として扱われます。
- **nl**: 節点荷重の配列 (オプション)
  - \`n\`: 荷重がかかる節点番号 (1から始まる整数)。
  - \`px\`: X方向荷重 (単位: kN)。右向きが正。
  - \`py\`: Y方向荷重 (単位: kN)。上向きが正。
  - \`mz\`: モーメント荷重 (単位: kN・m)。反時計回りが正。
- **ml**: 部材荷重の配列 (オプション)
  - \`m\`: 荷重がかかる部材番号 (1から始まる整数)。
  - \`w\`: 部材座標系y軸方向の等分布荷重 (単位: kN/m)。部材の上から下向きにかかる場合は正の値。

**重要なルール:**
- 座標系は、右方向がX軸の正、上方向がY軸の正です。
- 荷重の向きに注意してください。「下向き」の鉛直荷重は \`py\` が負の値になります。
- 部材の断面性能値 (\`A\`, \`I\`, \`Z\`) が不明な場合は、一般的な鋼材断面（例：H-300x150x6.5x9）の値を仮定して設定してください (A=0.004678, I=0.0000721, Z=0.000481)。
- 節点番号と部材番号は1から始まる連番です。
- 存在しない節点番号や部材番号を参照しないでください。
- **節点番号と部材参照の重要ルール（最重要）:**
  - **節点番号は配列の順序で決まります**: nodes配列の1番目=節点1、2番目=節点2、3番目=節点3...
  - **部材のiとjは必ず存在する節点番号を参照してください**
  - **絶対に存在しない節点番号を参照しないでください**
  - **例1**: nodes配列に4つの節点がある場合、部材は節点1、2、3、4のみを参照できます
  - **例2**: 節点配列が[{"x":0,"y":0}, {"x":6,"y":0}, {"x":0,"y":4}, {"x":6,"y":4}]の場合
    - 節点1: (0,0)、節点2: (6,0)、節点3: (0,4)、節点4: (6,4)
    - 部材で節点5や節点0を参照することは絶対に禁止です
  - **複数層ラーメン構造の生成ルール（最重要）:**
    - **層数とスパン数を絶対に正確に理解してください**: 
      - 「3層3スパン」= 3つの層 + 3つのスパン（4本の柱）
      - 「2層2スパン」= 2つの層 + 2つのスパン（3本の柱）
      - 「4層4スパン」= 4つの層 + 4つのスパン（5本の柱）
    - **スパン数の理解（絶対に間違えないでください）:**
      - スパン数 = 柱の本数 - 1
      - 3スパン = 4本の柱が必要（左端、中間2本、右端）
      - 各層に同じ本数の柱を配置してください
    - **節点番号は下層から上層へ、左から右へ順序良く付けてください**
    - **各層の柱は垂直に並べ、同じX座標に配置してください**
    - **梁は各層の柱間を水平に接続してください**
    - **層の高さは一般的な値を設定してください**: 1層=4m、2層=8m、3層=12mなど
    - **スパン長は一般的な値を設定してください**: 6m、8m、10mなど
    - **節点数の計算**: (スパン数+1)×層数（柱脚）+ (スパン数+1)×層数（柱頭）= (スパン数+1)×層数×2
    - **部材数の計算**: (スパン数+1)×層数（柱）+ 層数×スパン数（梁）= (スパン数+1)×層数 + 層数×スパン数
- **柱脚の境界条件に関する重要なルール:**
  - Y座標が0の節点（地面に接する節点）は柱脚として扱います。
  - ユーザーの指示で「柱脚は固定」「基礎は固定」「支点は固定」などの記述がある場合、Y座標=0の節点の境界条件を "x" (固定) に設定してください。
  - 「柱脚はピン」「基礎はピン」「支点はピン」などの記述がある場合、Y座標=0の節点の境界条件を "p" (ピン) に設定してください。
  - 「柱脚はローラー」「基礎はローラー」「支点はローラー」などの記述がある場合、Y座標=0の節点の境界条件を "r" (ローラー) に設定してください。
  - 柱脚に関する明示的な指示がない場合でも、一般的な構造では柱脚は固定とするのが合理的です。特に「門型ラーメン」「フレーム」「ラーメン構造」などの記述がある場合は、Y座標=0の節点を "x" (固定) に設定してください。
- ユーザーの指示に曖昧な点がある場合は、最も一般的で合理的な構造を仮定してモデルを作成してください。
- **構造生成時の注意事項（必須確認事項）:**
  - **節点番号は配列の順序（1から始まる）で決まります**
  - **部材の\`i\`と\`j\`は必ず存在する節点番号を参照してください**
  - **生成前に必ず節点数と部材の節点参照を確認してください**
  - **ラーメン構造では、柱と梁の接続が正確になるよう節点配置を確認してください**
  - **複数層構造では、各層の高さを適切に設定してください（例: 1層=4m、2層=8m、3層=12m）**
  - **スパン長は一般的な値を設定してください（例: 6m、8m、10m）**
  - **複数層・複数スパン構造の生成時は特に注意:**
    - 「○層○スパン」の指示を正確に理解し、指定された層数とスパン数で構造を作成してください
    - **スパン数の理解が最重要**: スパン数 = 柱の本数 - 1
    - **3スパン = 4本の柱が必要**（左端、中間2本、右端）
    - 節点数は(スパン数+1)×層数になります
    - 部材数は(スパン数+1)×層数（柱）+ 層数×スパン数（梁）になります
    - 例：「3層3スパン」なら16節点と21部材が必要です
  - **生成後は必ず以下のチェックを行ってください:**
    1. 節点配列の長さを確認
    2. 各部材のiとjが節点配列の範囲内（1～節点数）であることを確認
    3. 存在しない節点番号を参照していないことを確認
    4. 層数とスパン数が指示通りになっていることを確認
`;

    if (mode === 'edit' && currentModel) {
        prompt += `

**現在のモデル情報:**
節点数: ${currentModel.nodes ? currentModel.nodes.length : 0}
部材数: ${currentModel.members ? currentModel.members.length : 0}
節点荷重数: ${currentModel.nodeLoads ? currentModel.nodeLoads.length : 0}
部材荷重数: ${currentModel.memberLoads ? currentModel.memberLoads.length : 0}

編集時は以下の点に注意してください:
- 既存の節点番号と部材番号の連続性を保持してください
- 既存の構造の基本形状は維持し、指示された変更のみを適用してください
- **境界条件の扱い**: 
  - ユーザーが境界条件の変更を明示的に指示した場合のみ、その指示に従って境界条件を変更してください
  - 境界条件の変更指示がない場合は、既存の節点の境界条件（s）を必ず保持してください
  - 境界条件の変更指示の例：「柱脚を固定からピンに変更」「支点をローラーに変更」「節点○の境界条件を変更」など
- 新しく追加する節点や部材は、既存の番号の続きから開始してください
- 削除する場合は、後続の番号を詰める必要はありません
- **節点の座標変更の場合**:
  - 「スパンを○mに変更」「梁の長さを○mに変更」などの指示では、既存の節点の座標を変更してください
  - 既存の節点の座標（x, y）を新しい座標に変更することで、構造の形状を修正できます
  - 既存の節点を修正する場合は、同じ配列位置で節点データを出力してください
  - 例: 1番目の節点の座標を変更する場合、nodes配列の1番目として新しい座標を持つデータを出力してください
- **部材の長さ変更や位置変更の場合**:
  - 「スパンを○mに変更」「梁の長さを○mに変更」などの指示では、既存の部材の節点番号を変更して長さを調整してください
  - 既存の部材の節点番号（i, j）を新しい座標の節点に変更することで、部材の長さや位置を修正できます
  - 必要に応じて新しい節点を追加し、既存部材の接続先を変更してください
  - **重要**: 既存の部材を修正する場合は、同じ配列位置で部材データを出力してください
  - 例: 既存の1番目の部材が節点1→2で、これを節点1→3に変更する場合、members配列の1番目として節点1→3のデータを出力してください
`;
    }

    return prompt;
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
    }
    
    if (currentModel && currentModel.nodes && currentModel.nodes.length > 0) {
        editPrompt += `現在の節点情報:\n`;
        currentModel.nodes.forEach((node, index) => {
            const supportText = {
                'f': '自由',
                'p': 'ピン', 
                'x': '固定',
                'r': 'ローラー'
            }[node.s] || node.s;
            editPrompt += `節点${index + 1}: (${node.x}, ${node.y}) - ${supportText}\n`;
        });
        editPrompt += `\n`;
        
        editPrompt += `節点修正時の注意事項:\n`;
        editPrompt += `- 既存の節点を修正する場合は、同じ配列位置（1番目、2番目など）で出力してください\n`;
        editPrompt += `- 座標（x, y）を変更することで節点の位置を修正できます\n`;
        editPrompt += `- **境界条件の扱い**: \n`;
        editPrompt += `  - 境界条件の変更指示がある場合のみ、その指示に従って境界条件を変更してください\n`;
        editPrompt += `  - 境界条件の変更指示がない場合は、既存の節点の境界条件（s）を必ず保持してください\n`;
        editPrompt += `- 例: 1番目の節点の座標を変更する場合、nodes配列の1番目として新しい座標と適切な境界条件を持つデータを出力してください\n`;
        editPrompt += `- 既存の節点を削除する場合は、その節点を出力しないでください\n`;
        editPrompt += `\n`;
    }
    
    if (currentModel && currentModel.members && currentModel.members.length > 0) {
        editPrompt += `現在の部材情報:\n`;
        currentModel.members.forEach((member, index) => {
            const length = member.length ? ` (長さ: ${member.length.toFixed(2)}m)` : '';
            const section = member.sectionName ? ` (断面: ${member.sectionName})` : '';
            editPrompt += `部材${index + 1}: 節点${member.i} → 節点${member.j}${length}${section}\n`;
        });
        editPrompt += `\n`;
        
        editPrompt += `部材修正時の注意事項:\n`;
        editPrompt += `- 既存の部材を修正する場合は、同じ配列位置（1番目、2番目など）で出力してください\n`;
        editPrompt += `- 節点番号（i, j）を変更することで部材の長さや位置を修正できます\n`;
        editPrompt += `- 例: 1番目の部材の長さを変更する場合、members配列の1番目として新しい節点番号を持つデータを出力してください\n`;
        editPrompt += `- 既存の部材を削除する場合は、その部材を出力しないでください\n`;
        editPrompt += `\n`;
    }
    
    if (currentModel && currentModel.nodeLoads && currentModel.nodeLoads.length > 0) {
        editPrompt += `現在の節点荷重:\n`;
        currentModel.nodeLoads.forEach((load, index) => {
            editPrompt += `節点${load.n}: Fx=${load.fx}, Fy=${load.fy}, Mz=${load.mz}\n`;
        });
        editPrompt += `\n`;
    }
    
    if (currentModel && currentModel.memberLoads && currentModel.memberLoads.length > 0) {
        editPrompt += `現在の部材荷重:\n`;
        currentModel.memberLoads.forEach((load, index) => {
            editPrompt += `部材${load.m}: ${load.type} ${load.magnitude} (位置:${load.position})\n`;
        });
        editPrompt += `\n`;
    }
    
    editPrompt += `上記の現在のモデルに対して、指示された編集を適用してください。`;
    
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
    
    if (hasBoundaryKeyword && hasChangeKeyword) {
        detected = true;
        
        // 変更対象を特定
        if (prompt.includes('柱脚') || prompt.includes('基礎')) {
            target = '柱脚（Y座標=0の節点）';
        } else if (prompt.includes('支点')) {
            target = '支点';
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
    
    if (!model.nodes || !Array.isArray(model.nodes)) {
        errors.push('節点配列が存在しません');
        return { isValid: false, errors: errors };
    }
    
    if (!model.members || !Array.isArray(model.members)) {
        errors.push('部材配列が存在しません');
        return { isValid: false, errors: errors };
    }
    
    const nodeCount = model.nodes.length;
    
    // 各節点の基本的な構造をチェック
    model.nodes.forEach((node, index) => {
        if (!node.hasOwnProperty('x') || !node.hasOwnProperty('y') || !node.hasOwnProperty('s')) {
            errors.push(`節点${index + 1}に必須プロパティ（x, y, s）が不足しています`);
        }
        if (typeof node.x !== 'number' || typeof node.y !== 'number') {
            errors.push(`節点${index + 1}の座標が数値ではありません`);
        }
        if (!['f', 'p', 'r', 'x'].includes(node.s)) {
            errors.push(`節点${index + 1}の境界条件（${node.s}）が無効です`);
        }
    });
    
    // 各部材の節点参照をチェック
    model.members.forEach((member, index) => {
        if (!member.hasOwnProperty('i') || !member.hasOwnProperty('j')) {
            errors.push(`部材${index + 1}に必須プロパティ（i, j）が不足しています`);
            return;
        }
        
        const i = member.i;
        const j = member.j;
        
        if (!Number.isInteger(i) || !Number.isInteger(j)) {
            errors.push(`部材${index + 1}の節点番号（${i}, ${j}）が整数ではありません`);
            return;
        }
        
        if (i < 1 || i > nodeCount) {
            errors.push(`部材${index + 1}の開始節点番号（${i}）が範囲外です（1-${nodeCount}）`);
        }
        
        if (j < 1 || j > nodeCount) {
            errors.push(`部材${index + 1}の終了節点番号（${j}）が範囲外です（1-${nodeCount}）`);
        }
        
        if (i === j) {
            errors.push(`部材${index + 1}の開始節点と終了節点が同じです（${i}）`);
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
                    return;
                }
                if (!Number.isInteger(nodeNumber) || nodeNumber < 1 || nodeNumber > nodeCount) {
                    errors.push(`節点荷重${index + 1}の節点番号（${nodeNumber}）が範囲外です（1-${nodeCount}）`);
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
                    return;
                }
                if (!Number.isInteger(memberNumber) || memberNumber < 1 || memberNumber > model.members.length) {
                    errors.push(`部材荷重${index + 1}の部材番号（${memberNumber}）が範囲外です（1-${model.members.length}）`);
                }
            });
        }
    }
    
    // スパン数の検証（ラーメン構造の場合）
    const spanValidation = validateSpanCount(model);
    if (!spanValidation.isValid) {
        errors.push(...spanValidation.errors);
    }
    
    return {
        isValid: errors.length === 0,
        errors: errors
    };
}

// スパン数を検証する関数
function validateSpanCount(model) {
    const errors = [];
    
    if (!model.nodes || !model.members || model.nodes.length < 4 || model.members.length < 3) {
        return { isValid: true, errors: [] }; // 最小限の構造でない場合はスキップ
    }
    
    // Y座標=0の節点（柱脚）の数をカウント
    const groundNodes = model.nodes.filter(node => node.y === 0);
    const spanCount = groundNodes.length - 1;
    
    // 各層の節点数をカウント
    const layerCounts = {};
    model.nodes.forEach(node => {
        const layer = node.y;
        layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    });
    
    // 各層の節点数が一致するかチェック
    const layerNodeCounts = Object.values(layerCounts);
    const expectedNodeCount = groundNodes.length;
    
    for (const count of layerNodeCounts) {
        if (count !== expectedNodeCount) {
            errors.push(`層によって節点数が異なります。柱脚: ${expectedNodeCount}個、他の層: ${count}個`);
            break;
        }
    }
    
    // 部材数の検証
    const expectedColumnCount = expectedNodeCount * layerNodeCounts.length;
    const expectedBeamCount = spanCount * layerNodeCounts.length;
    const expectedTotalMembers = expectedColumnCount + expectedBeamCount;
    
    if (model.members.length !== expectedTotalMembers) {
        errors.push(`部材数が不正です。期待値: ${expectedTotalMembers}個、実際: ${model.members.length}個`);
    }
    
    // スパン数の検証（一般的なラーメン構造の場合）
    if (spanCount < 1 || spanCount > 10) {
        errors.push(`スパン数が異常です: ${spanCount}スパン`);
    }
    
    return {
        isValid: errors.length === 0,
        errors: errors
    };
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