# GemLog Next — 改善計画書

> GemLog v1 を多面的に分析し、v2 (GemLog Next) での改善を体系的にまとめたドキュメント。

---

## 1. 現状分析（GemLog v1 の課題）

### UI/UX
| 課題 | 詳細 |
|------|------|
| デザインの平凡さ | 汎用的なblue系カラーで差別化がない |
| 検索機能なし | チャットが増えると目的のものを探せない |
| 整理ツールがない | タグ・フィルタ・お気に入りがなく管理が困難 |
| APIキーが常時見える | パスワードフィールドのshow/hideがない |
| ソートできない | 時系列以外の並び替えができない |
| ストレージ表示が粗い | 使用量/上限が不明瞭 |

### セキュリティ
| 課題 | 詳細 |
|------|------|
| カスタムエンドポイント未検証 | http:// や内部URLが設定可能 |
| CSPが未明示 | manifest に content_security_policy がない |
| プロンプトインジェクションリスク | チャット内容が要約プロンプトに直接展開される |

### 機能
| 課題 | 詳細 |
|------|------|
| エクスポート形式が限定的 | Markdown/JSONのみ（Obsidianなど不可） |
| チャット管理機能が薄い | タグなし、整理手段がない |

### コード品質
| 課題 | 詳細 |
|------|------|
| 型定義なし | JSDoc型アノテーションがない |
| エラーメッセージが抽象的 | デバッグ困難 |
| モジュール責任が曖昧 | ui-managerへの依存関係が複雑 |

---

## 2. UI/UX 改善（実装済み）

### 2-1. デザイン刷新：Crystalline Dark

**変更前 → 変更後**
- 背景色: `#1a1a2e` (ネイビー) → `#080c14` (ディープブラック)
- アクセント: `#4a9eff` (ブルー) → `#10b981` (エメラルドグリーン)
- カード: 単色 → Glassmorphism (`rgba(255,255,255,0.04)`)
- グラデーション: 単色 → エメラルド→シアン (`#10b981` → `#06b6d4`)

**根拠**
- エメラルドグリーンは「記録」「ログ」のイメージと一致し、他AIツールと差別化できる
- Glassmorphismはデプス感を出しつつ軽量なCSS実装が可能

### 2-2. 検索機能（リアルタイム）

```
ヘッダー [🔍] → 検索バーが slideDown アニメーション
入力: 200ms デバウンスでタイトル・タグを横断検索
```

- `GemLogStorage.searchChats(query)` でインデックスを検索
- タグクリックで自動的に検索バーへ入力（タグフィルタ）

### 2-3. ソート・フィルタコントロール

| オプション | 動作 |
|------------|------|
| 最新順 | updatedが新しい順（デフォルト） |
| 古い順 | createdが古い順 |
| メッセージ数順 | messageCount降順 |
| お気に入り優先 | ★が先頭、同グループ内は最新順 |
| 絞込: お気に入り | favoritesに含まれるものだけ表示 |

### 2-4. お気に入り（★）機能

- チャットカードの★ボタンでトグル
- 詳細パネルからもトグル可能
- `chrome.storage.local` の settings.favorites 配列で管理
- ソート・フィルタと連動

### 2-5. タグシステム

- チャットデータに `tags: string[]` フィールドを追加
- インデックスにもタグを同期（高速な絞込のため）
- タグをクリック → 検索バーに自動入力してフィルタリング
- `addTag/removeTag` で非同期に管理

### 2-6. APIキー表示トグル

```
[password input] [👁 トグルボタン]
→ type="password" ↔ type="text" の切替
```

### 2-7. アニメーション

| 箇所 | アニメーション |
|------|----------------|
| チャットカード | fadeSlideIn (animation-delay: N×35ms でスタガー) |
| 検索バー | slideDown 0.18s |
| ロゴアイコン | box-shadow glow |
| ストレージバー | width transition 0.4s |
| 空アイコン | float (上下に浮遊) |

---

## 3. セキュリティ改善（実装済み）

### 3-1. カスタムエンドポイントURL検証

**background.js**
```javascript
function isValidHttpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch { return false; }
}
// case 'custom': で呼び出し
```

**popup の inline バリデーション**
- `apiEndpoint` 入力のたびに `isValidHttpsUrl()` でリアルタイム検証
- ✓ Valid HTTPS URL / ✗ Invalid の視覚フィードバック
- 保存時にも再検証（二重防止）

### 3-2. 明示的なCSP

`manifest.json`:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

### 3-3. APIキーヒント

設定画面に「ローカルにのみ保存。設定したAPI以外には送信されません。」の注記を追加。

---

## 4. 機能追加（実装済み）

### 4-1. Obsidian エクスポート

Obsidian の Callout 形式:
```markdown
---
title: "チャットタイトル"
tags: [gemini, chat, mytag]
---

> [!question] User
> ユーザーのメッセージ

> [!note] Gemini
> Geminiの回答
```

`GemLogStorage.chatToObsidian(chatData)` で生成。

### 4-2. エクスポート形式の設定

設定に「デフォルトエクスポート形式」セレクタを追加:
- Markdown (.md)
- JSON (.json)
- Obsidian Markdown

---

## 5. コード品質改善（実装済み）

| 改善点 | 詳細 |
|--------|------|
| JSDoc型アノテーション | 主要関数に `@param` / `@returns` を追加 |
| URLバリデーション | utils.js に `isValidHttpsUrl` / `sanitizeFilename` を集約 |
| エラーメッセージの具体化 | `errEndpointNotHttps` など専用キーを追加 |
| 未使用パラメータ | `_sender` などのアンダースコア表記で明示 |
| DOM操作の責任分離 | validateEndpointUrl を ui-manager に移動 |

---

## 6. 今後のロードマップ

### Phase 2（次フェーズ候補）

| 機能 | 概要 | 優先度 |
|------|------|--------|
| タグ追加UI | 詳細パネルからタグを追加・削除できるUI | ★★★ |
| メッセージ全文検索 | インデックスでなくチャット本文を検索 | ★★★ |
| 一括エクスポート | 全チャットをZIPでダウンロード | ★★☆ |
| チャット統計 | 総メッセージ数・コードブロック数・使用言語 | ★★☆ |
| ショートカットキー | Ctrl+F で検索、Backspaceで戻るなど | ★★☆ |
| コードブロック表示 | 詳細パネルでコードをシンタックスハイライト | ★★☆ |

### Phase 3（将来構想）

| 機能 | 概要 |
|------|------|
| Chrome Sync 対応 | `chrome.storage.sync` でデバイス間同期 |
| 複数AIサービス対応 | ChatGPT・Claude.ai にも対応 |
| 自動バックアップ | 定期的にローカルファイルへエクスポート |
| TypeScript 移行 | 型安全性を担保したコードベースへ移行 |
| ビルドシステム導入 | Vite + TypeScript + テスト環境の整備 |

---

## 7. 比較表：v1 vs v2

| 項目 | GemLog v1 | GemLog Next |
|------|-----------|-------------|
| デザイン | Blue/Navy | Crystalline Dark (Emerald) |
| 検索 | なし | リアルタイム検索（タイトル・タグ） |
| ソート | なし | 4種類 |
| フィルタ | なし | お気に入り絞込 |
| お気に入り | なし | ★トグル |
| タグ | なし | 追加・タグ検索 |
| APIキー表示 | 常時非表示 | 表示トグル |
| エクスポート | MD / JSON | MD / JSON / Obsidian |
| エンドポイント検証 | なし | https:// 強制 |
| CSP | 暗黙 | manifest に明示 |
| アニメーション | 最小限 | スタガー・スライド・フロート |
