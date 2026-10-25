export type AppEnv = {
  Bindings: Env;
  // 操作のログと、エラーのログで揃える。cf-ray が無いリクエストには乱数を振る
  Variables: { requestId: string };
};
