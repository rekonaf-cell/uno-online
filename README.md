# UNO Online

スマホのブラウザで複数人が離れた場所から遊べる、UNO風オリジナルカードゲームです。

## ローカルで動かす

```bash
npm install
npm start
```

`http://localhost:3000` を開きます。

## Renderへのデプロイ

1. このリポジトリをRenderの「New Web Service」で選択
2. Build Command: `npm install`
3. Start Command: `npm start`
4. デプロイ後に発行されるURLを、友達にも共有すればスマホから参加できます

## 遊び方

1. 一人が「部屋を作る」でルームコード(4桁)を発行
2. 他の人はそのコードを「参加する」に入力
3. 2人以上集まったらホストが「ゲーム開始」
4. 場のカードと同じ色・同じ数字/記号のカードを出す。出せなければ山札を引く
5. 手札がなくなったら勝利
