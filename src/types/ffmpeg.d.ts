declare module '@ffmpeg/ffmpeg' {
  export class FFmpeg {
    on(event: string, callback: (data: any) => void): void;
    load(): Promise<void>;
    exec(args: string[]): Promise<number>;
    fs: {
      writeFile(path: string, data: Uint8Array): void;
      readFile(path: string): Uint8Array;
      deleteFile(path: string): void;
    };
  }
  export function fetchFile(input: string | File | Blob): Promise<Uint8Array>;
}

declare module '@ffmpeg/util' {
  export function toBlobURL(url: string, mimeType: string): Promise<string>;
  export function fetchFile(input: string | File | Blob): Promise<Uint8Array>;
}
