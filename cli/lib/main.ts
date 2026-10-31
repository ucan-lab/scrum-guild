// sg コマンドの本体。終了コードを返す。node の組み込みは import しない（Workers のテストから本物の app の fetch を渡して呼ぶため）。
// src/ は import しない（操作の一覧は API から取る）
export type Profile = { url?: string; token?: string; org?: string; workspace?: string };

export type Config = { default_profile?: string; profiles: Record<string, Profile> };

export type ConfigStore = {
  read(): Promise<Config | undefined>;
  write(config: Config): Promise<void>;
};

export type CliDeps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  config: ConfigStore;
};

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  void argv;
  void deps;
  throw new Error('未実装');
}
