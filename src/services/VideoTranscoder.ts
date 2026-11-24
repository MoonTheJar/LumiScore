/**
 * VideoTranscoder.ts
 *
 * 浏览器端视频转码服务，基于 ffmpeg.wasm 实现。
 * 功能：
 * - 将视频转码为 480p@15fps（当原始视频超过限制时）
 * - 支持按时间裁剪（startTime / endTime）
 * - 提供 0-100 的进度回调
 * - 获取视频基本信息（分辨率、帧率、时长）
 *
 * 降级策略：如果 ffmpeg.wasm 不可用，直接返回原始视频的 Blob URL。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface TranscodeOptions {
  /** 输入视频文件 */
  input: File | Blob;
  /** 最大宽度，默认 480 */
  maxWidth?: number;
  /** 最大帧率，默认 15 */
  maxFps?: number;
  /** 裁剪开始时间（秒），可选 */
  startTime?: number;
  /** 裁剪结束时间（秒），可选 */
  endTime?: number;
  /** 进度回调，progress 范围 0-100 */
  onProgress?: (progress: number) => void;
}

export interface VideoInfo {
  /** 视频宽度 */
  width: number;
  /** 视频高度 */
  height: number;
  /** 视频帧率 */
  fps: number;
  /** 视频时长（秒） */
  duration: number;
}

// ffmpeg.wasm 的动态导入类型（避免编译时依赖）
interface FFmpegModule {
  FFmpeg: new () => FFmpegInstance;
  fetchFile: (file: File | Blob | string) => Promise<Uint8Array>;
}

interface FFmpegInstance {
  load: () => Promise<void>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  deleteFile: (path: string) => Promise<void>;
  exec: (args: string[]) => Promise<void>;
  on: (
    event: "log" | "progress",
    callback: (data: { message?: string; progress?: number }) => void,
  ) => void;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_MAX_WIDTH = 480;
const DEFAULT_MAX_FPS = 15;

// 输入/输出文件名（在 ffmpeg.wasm 虚拟文件系统中使用）
const INPUT_FILENAME = "input";
const OUTPUT_FILENAME = "output.mp4";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从 File 或 Blob 创建临时 URL，用于降级场景。
 */
function createObjectURL(input: File | Blob): string {
  return URL.createObjectURL(input);
}

/**
 * 动态导入 ffmpeg.wasm 模块。
 * 如果 @ffmpeg/ffmpeg 和 @ffmpeg/util 未安装，返回 null。
 */
async function loadFFmpeg(): Promise<FFmpegModule | null> {
  try {
    // 使用动态导入，避免打包时硬依赖
    const ffmpegModuleName = "@ffmpeg/ffmpeg";
    const ffmpeg = await import(/* @vite-ignore */ ffmpegModuleName);
    const utilModuleName = "@ffmpeg/util";
    const util = await import(/* @vite-ignore */ utilModuleName);
    return {
      FFmpeg: ffmpeg.FFmpeg as any,
      fetchFile: util.fetchFile,
    };
  } catch {
    // 包未安装或加载失败
    console.warn("[VideoTranscoder] ffmpeg.wasm not available, falling back to passthrough.");
    return null;
  }
}

/**
 * 解析 ffprobe 输出的视频流信息。
 * ffprobe 输出格式为 JSON，包含 streams 数组。
 */
function parseVideoInfo(ffprobeOutput: string): VideoInfo {
  const data = JSON.parse(ffprobeOutput);
  const stream = data.streams?.find((s: { codec_type?: string }) => s.codec_type === "video");

  if (!stream) {
    throw new Error("No video stream found in input file.");
  }

  const width = stream.width ?? 0;
  const height = stream.height ?? 0;
  const duration = parseFloat(stream.duration ?? data.format?.duration ?? "0");

  // 解析帧率（可能是分数形式如 "30000/1001"）
  let fps = 0;
  if (stream.r_frame_rate) {
    const [num, den] = stream.r_frame_rate.split("/").map(Number);
    if (den && den !== 0) {
      fps = num / den;
    } else {
      fps = Number(stream.r_frame_rate);
    }
  } else if (stream.avg_frame_rate) {
    const [num, den] = stream.avg_frame_rate.split("/").map(Number);
    if (den && den !== 0) {
      fps = num / den;
    }
  }

  return { width, height, fps, duration };
}

// ---------------------------------------------------------------------------
// VideoTranscoder 类
// ---------------------------------------------------------------------------

export class VideoTranscoder {
  private cachedInfo: VideoInfo | null = null;

  /**
   * 获取视频基本信息（分辨率、帧率、时长）。
   * 优先使用 ffmpeg.wasm 的 ffprobe，降级时使用浏览器原生 VideoElement。
   */
  async getVideoInfo(file: File | Blob): Promise<VideoInfo> {
    const ffmpegModule = await loadFFmpeg();

    if (ffmpegModule) {
      // 使用 ffmpeg.wasm 的 ffprobe 获取精确信息
      const { FFmpeg, fetchFile } = ffmpegModule;
      const ffmpeg = new FFmpeg();
      await ffmpeg.load();

      try {
        const inputData = await fetchFile(file);
        const ext = (file instanceof File ? file.name : "input").split(".").pop() || "mp4";
        const inputName = `${INPUT_FILENAME}.${ext}`;
        await ffmpeg.writeFile(inputName, inputData);

        // 使用 ffprobe 获取 JSON 格式信息
        // 通过 log 事件捕获输出
        let probeOutput = "";
        const logHandler = (data: { message?: string; progress?: number }) => {
          if (data.message) {
            probeOutput += data.message + "\n";
          }
        };
        ffmpeg.on("log", logHandler);
        
        await ffmpeg.exec([
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_streams",
          "-show_format",
          inputName,
        ]);
        
        const info = parseVideoInfo(probeOutput);

        // 清理临时文件
        await ffmpeg.deleteFile(inputName).catch(() => {});

        this.cachedInfo = info;
    return info;
      } catch (err) {
        console.warn("[VideoTranscoder] ffprobe failed, falling back to browser probe:", err);
        // 降级到浏览器原生方式
      }
    }

    // 降级：使用 HTMLVideoElement 获取基本信息
    return this.probeWithVideoElement(file);
  }

  /** Get cached video info from last getVideoInfo() call. */
  getCachedVideoInfo(): VideoInfo | null {
    return this.cachedInfo;
  }

  /**
   * 使用浏览器原生 VideoElement 探测视频信息。
   */
  private probeWithVideoElement(file: File | Blob): Promise<VideoInfo> {
    return new Promise((resolve, reject) => {
      const url = createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        video.remove();
      };

      video.addEventListener("loadedmetadata", () => {
        const width = video.videoWidth;
        const height = video.videoHeight;
        const duration = video.duration || 0;
        // 浏览器无法直接获取帧率，返回 0 表示未知
        const fps = 0;
        cleanup();
        resolve({ width, height, fps, duration });
      });

      video.addEventListener("error", () => {
        cleanup();
        reject(new Error("Failed to probe video metadata with browser."));
      });

      video.src = url;
    });
  }

  /**
   * 转码视频。
   *
   * 逻辑流程：
   * 1. 尝试加载 ffmpeg.wasm
   * 2. 如果不可用，直接返回原始视频的 Blob URL（降级）
   * 3. 使用 ffprobe 获取视频信息
   * 4. 判断是否需要转码（分辨率 > maxWidth 或 帧率 > maxFps 或有裁剪参数）
   * 5. 如不需要转码，直接返回原始 URL
   * 6. 构建 ffmpeg 命令并执行转码
   * 7. 读取输出文件，创建 Blob URL 返回
   */
  async transcode(options: TranscodeOptions): Promise<string> {
    const {
      input,
      maxWidth = DEFAULT_MAX_WIDTH,
      maxFps = DEFAULT_MAX_FPS,
      startTime,
      endTime,
      onProgress,
    } = options;

    // 步骤 1：尝试加载 ffmpeg.wasm
    const ffmpegModule = await loadFFmpeg();
    if (!ffmpegModule) {
      console.warn("[VideoTranscoder] ffmpeg.wasm unavailable, using direct file URL.");
      // 直接创建 blob URL，确保视频元素可以访问
      const url = URL.createObjectURL(input);
      console.log("[VideoTranscoder] Created blob URL:", url);
      return url;
    }

    const { FFmpeg, fetchFile } = ffmpegModule;
    const ffmpeg = new FFmpeg();

    // 绑定进度回调（ffmpeg.wasm v0.12+ 使用 progress 事件）
    if (onProgress) {
      ffmpeg.on("progress", ({ progress }) => {
        // progress 是 0-1 的小数，转换为 0-100
        if (typeof progress === "number") {
          onProgress(Math.min(100, Math.max(0, Math.round(progress * 100))));
        }
      });
    }

    // 步骤 2：加载 ffmpeg 核心
    await ffmpeg.load();

    // 步骤 3：写入输入文件
    const inputData = await fetchFile(input);
    const originalExt = (input instanceof File ? input.name : "input").split(".").pop() || "mp4";
    const inputName = `${INPUT_FILENAME}.${originalExt}`;
    await ffmpeg.writeFile(inputName, inputData);

    try {
      // 步骤 4：获取视频信息（使用 ffprobe）
      let info: VideoInfo;
      try {
        // ffprobe 输出通过日志事件捕获（ffmpeg.wasm 不支持 ">" 重定向）
        let probeOutput = "";
        const logHandler = (data: { message?: string; progress?: number }) => {
          if (data.message) {
            probeOutput += data.message + "\n";
          }
        };
        ffmpeg.on("log", logHandler);
        
        await ffmpeg.exec([
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_streams",
          "-show_format",
          inputName,
        ]);
        
        // ffmpeg.wasm 没有 off 方法，但 exec 完成后不会再触发 log
        info = parseVideoInfo(probeOutput);
      } catch {
        // ffprobe 失败，使用浏览器探测作为后备
        info = await this.probeWithVideoElement(input);
      }

      // 步骤 5：判断是否需要转码
      const needsResize = info.width > maxWidth;
      const needsFpsLimit = info.fps > maxFps;
      const needsTrim = startTime !== undefined || endTime !== undefined;

      if (!needsResize && !needsFpsLimit && !needsTrim) {
        // 视频参数已符合要求
        // 但为确保内部播放格式统一，非 MP4 文件需要 remux（stream copy，无需重编码）
        const isMP4 = input instanceof File && input.name.toLowerCase().endsWith('.mp4');
        const isWebM = input instanceof File && input.name.toLowerCase().endsWith('.webm');
        if (isMP4 || isWebM) {
          console.log("[VideoTranscoder] Video already meets requirements and is browser-compatible, skipping transcode.");
          return createObjectURL(input);
        }
        console.log("[VideoTranscoder] Video meets requirements but needs remux to MP4 for compatibility.");
        // Remux: copy streams into MP4 container without re-encoding (fast)
        const remuxArgs = ["-y", "-i", inputName, "-c", "copy", "-f", "mp4", OUTPUT_FILENAME];
        await ffmpeg.exec(remuxArgs);
        const remuxData = await ffmpeg.readFile(OUTPUT_FILENAME);
        const remuxBlob = new Blob([new Uint8Array(remuxData)], { type: "video/mp4" });
        return URL.createObjectURL(remuxBlob);
      }

      // 步骤 6：构建 ffmpeg 命令
      const argsObj: any = {
        inputName,
        outputName: OUTPUT_FILENAME,
        info,
        maxWidth,
        maxFps,
        startTime,
        endTime,
      };

      // 步骤 7：执行转码
      await ffmpeg.exec(this.buildFFmpegArgs(argsObj));

      // 步骤 8：读取输出文件
      const outputData = await ffmpeg.readFile(OUTPUT_FILENAME);
      const outputBlob = new Blob([new Uint8Array(outputData)], { type: "video/mp4" });
      const outputUrl = URL.createObjectURL(outputBlob);

      return outputUrl;
    } finally {
      // 清理虚拟文件系统中的临时文件
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(OUTPUT_FILENAME).catch(() => {});
    }
  }

  /**
   * 构建 ffmpeg 转码命令参数。
   */
  private buildFFmpegArgs(params: {
    inputName: string;
    outputName: string;
    info: VideoInfo;
    maxWidth: number;
    maxFps: number;
    startTime?: number;
    endTime?: number;
  }): string[] {
    const { inputName, outputName, info, maxWidth, maxFps, startTime, endTime } = params;

    const args: string[] = [];

    // 覆盖输出文件（避免交互式确认）
    args.push("-y");

    // 输入文件
    args.push("-i", inputName);

    // 裁剪：起始时间
    if (startTime !== undefined && startTime > 0) {
      args.push("-ss", String(startTime));
    }

    // 裁剪：持续时间（优先使用 -t，如果提供了 endTime）
    if (endTime !== undefined) {
      const duration = startTime !== undefined ? endTime - startTime : endTime;
      if (duration > 0) {
        args.push("-t", String(duration));
      }
    }

    // 视频编码器：libx264（H.264，浏览器兼容性最好）
    args.push("-c:v", "libx264");

    // 缩放滤镜：保持宽高比，限制最大宽度
    if (info.width > maxWidth) {
      // scale=w=480:h=-2 表示宽度固定为 480，高度按比例缩放并确保为偶数（H.264 要求）
      args.push("-vf", `scale=w=${maxWidth}:h=-2`);
    }

    // 帧率限制
    if (info.fps > maxFps) {
      args.push("-r", String(maxFps));
    }

    // 预设：ultrafast（牺牲压缩率换取速度，适合浏览器端实时转码）
    args.push("-preset", "ultrafast");

    // 质量：CRF 28（在速度和画质间取得平衡）
    args.push("-crf", "28");

    // 音频编码器：aac（浏览器兼容性最好）
    args.push("-c:a", "aac");

    // 音频码率：128k
    args.push("-b:a", "128k");

    // 输出格式：mp4
    args.push("-f", "mp4");

    // 输出文件
    args.push(outputName);

    return args;
  }
}