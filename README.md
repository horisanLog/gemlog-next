# GemLog Next

Google Gemini のチャット履歴を自動記録する Chrome 拡張の改善版。
検索・タグ・お気に入り・AI要約・複数エクスポート形式に対応。

## 主な機能

- **自動ログ記録** — Gemini でのチャットを自動的に `chrome.storage.local` へ保存
- **リアルタイム検索** — チャット名・タグで即時絞り込み
- **お気に入り（★）** — 重要なチャットをスター付きで管理
- **タグシステム** — チャットにタグを付けて分類
- **ソート・フィルタ** — 最新順・古い順・メッセージ数順・お気に入り優先
- **AI 要約** — Google AI / OpenAI / Anthropic / カスタム API で要約生成
- **複数エクスポート** — Markdown / JSON / Obsidian 形式に対応

## GemLog v1 からの主な改善点

| 項目 | v1 | v2 (Next) |
|------|----|-----------|
| デザイン | Blue/Navy | Crystalline Dark (Emerald) |
| 検索 | なし | リアルタイム検索 |
| ソート | なし | 4種類 |
| お気に入り | なし | ★トグル |
| タグ | なし | タグ付け・タグ検索 |
| エクスポート | MD/JSON | MD/JSON/Obsidian |
| エンドポイント検証 | なし | https:// 強制 |

詳細は [PLAN.md](./PLAN.md) を参照。

## インストール方法

1. このリポジトリをクローン（または ZIP ダウンロード）
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」をオン
4. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択

## 権限

| 権限 | 用途 |
|------|------|
| `storage` / `unlimitedStorage` | チャットログをローカルに保存 |
| `activeTab` | アクティブなGeminiタブの情報取得 |
| `host: gemini.google.com` | Geminiページのみに限定 |

## セキュリティ

- データはすべてローカル (`chrome.storage.local`) に保存される
- 外部への送信は設定したAPIのみ（要約機能使用時）
- カスタムAPIエンドポイントは `https://` のみ許可
- `manifest_version: 3` + 明示的CSP を使用
