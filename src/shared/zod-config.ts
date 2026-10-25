// zod の設定。操作の定義（src/shared/operations/）が先に読み込む。
// zod 4 は、スキーマを作るとき new Function('') で eval が使えるかを試す。例外は握りつぶされるが、
// script-src に 'unsafe-eval' の無い CSP（画面の CSP）では securitypolicyviolation が報告されるので、試さないようにする。
// 画面の束にも入るので、CSP を持たない Worker でも同じ設定にする（eval を使う速い経路を使わないだけ）
import { z } from 'zod';

z.config({ jitless: true });
