# Groq API設定ガイド

## 1. Groqアカウントの作成とAPIキーの取得

1. [Groq Console](https://console.groq.com/) にアクセス
2. アカウントを作成またはログイン
3. API Keys セクションに移動
4. "Create API Key" ボタンをクリック
5. APIキーを生成（一度しか表示されないため、必ずコピーして保存）

## 2. Vercelでの環境変数設定

### 方法1: Vercelダッシュボードから設定
1. Vercelダッシュボードにログイン
2. プロジェクトを選択
3. Settings → Environment Variables
4. 新しい環境変数を追加：
   - Name: `GROQ_API_KEY`
   - Value: 取得したGroq APIキー
   - Environment: Production, Preview, Development（すべて選択）

### 方法2: Vercel CLIを使用
```bash
vercel env add GROQ_API_KEY
# プロンプトでAPIキーを入力
```

## 3. ローカル開発環境での設定

`.env.local` ファイルを作成（プロジェクトルートに）：
```
GROQ_API_KEY=your_groq_api_key_here
```

## 4. 利用可能なGroqモデル

- `openai/gpt-oss-120b` (推奨) - 高性能で汎用性が高い
- `llama-3.1-70b-versatile` - 高性能で汎用性が高い
- `llama-3.1-8b-instant` - 高速だが性能はやや劣る
- `mixtral-8x7b-32768` - 中程度の性能と速度

## 5. API制限と料金

- Groqは無料プランで月間制限があります
- 詳細は [Groq Pricing](https://console.groq.com/docs/pricing) を確認

## 6. トラブルシューティング

### よくあるエラー
- `401 Unauthorized`: APIキーが正しく設定されていない
- `429 Too Many Requests`: レート制限に達している
- `500 Internal Server Error`: Groqサーバーの一時的な問題

### 解決方法
1. APIキーが正しく設定されているか確認
2. レート制限の場合は少し待ってから再試行
3. サーバーエラーの場合は時間をおいて再試行
