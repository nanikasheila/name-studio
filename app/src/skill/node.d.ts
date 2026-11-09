// The little of Node the Skills' command line uses (the app's code has no Node types).
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function renameSync(from: string, to: string): void;
  export function copyFileSync(from: string, to: string): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { mtimeMs: number };
  export function unlinkSync(path: string): void;
}
declare const process: {
  argv: string[];
  pid: number;
  exitCode: number | undefined;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
};
