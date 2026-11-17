"use client";

import { useRef, useState } from "react";
import type { ImageMatch } from "@weave-order/schema";
import { Badge, Button, Spinner } from "@weave-order/ui";
import { useApi } from "@/providers";
import { compressImageFile, uploadToPresignedUrl } from "@/image-compress";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedMime = (typeof ALLOWED_MIME)[number];

/** 与移动端同一预算：长边 ≤1600 / ≤1MB。 */
const RAW_UPLOAD_MAX_BYTES = 1024 * 1024;

function isAllowedMime(value: string): value is AllowedMime {
  return (ALLOWED_MIME as readonly string[]).includes(value);
}

/**
 * 桌面「以图找样」：上传一张查询图（拍照导出的文件也行），拿服务端 top-5 候选。
 *
 * 为什么不复用详情抽屉里那个按钮：那里只能拿「已有样品的主图」当查询图，
 * 用户手里有一张新布样照片时没有入口。链路与移动端完全一致：
 * presign → 直传对象存储 → 把服务端返回的 publicUrl 交给 T-001。
 */
export function SampleImageSearch({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ImageMatch[]>([]);
  const [meta, setMeta] = useState<{ semantic: boolean; mode: string; indexing: number } | null>(
    null,
  );

  const reset = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setMatches([]);
    setMeta(null);
    setError(null);
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setBusy(true);
    try {
      // ≤1MB 且是白名单格式时原样上传：不经 canvas 重编码，
      // 分数才与库里的同一张图可比（local-stub 下尤其重要）。
      const raw = isAllowedMime(file.type) && file.size <= RAW_UPLOAD_MAX_BYTES;
      const upload: {
        blob: Blob;
        mimeType: AllowedMime;
        byteSize: number;
        previewUrl?: string;
      } = raw
        ? { blob: file, mimeType: file.type, byteSize: file.size }
        : await (async () => {
            const compressed = await compressImageFile(file);
            return {
              blob: compressed.blob,
              mimeType: "image/jpeg",
              byteSize: compressed.byteSize,
              previewUrl: compressed.previewUrl,
            };
          })();
      setPreviewUrl(upload.previewUrl ?? URL.createObjectURL(file));

      const presigned = await api.presignImage({
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
      });
      await uploadToPresignedUrl(presigned.uploadUrl, presigned.headers, upload.blob);
      const result = await api.searchByImageUrl(presigned.publicUrl);
      if (!result.ok) {
        setError(result.error?.message ?? "以图找样失败");
        return;
      }
      setMatches(result.data.matches);
      setMeta({
        semantic: result.data.semantic ?? true,
        mode: result.data.mode ?? "image",
        indexing: result.data.indexing ?? 0,
      });
      if (result.data.matches.length === 0) {
        setError(
          (result.data.indexing ?? 0) > 0
            ? `还有 ${result.data.indexing} 张样品图在建立索引，稍后重试。`
            : "没有找到相似样品。换一张光线更好的，或改用规格筛选。",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "以图找样失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="image-search-panel"
      className="grid gap-3 rounded-lg border border-line bg-surface px-3 py-3"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-900">以图找样</p>
          <p className="text-xs text-ink-400">
            上传一张布样照片，找相似面料；缩略图就是匹配到的样品图。
          </p>
        </div>
        <Button
          variant="ghost"
          className="min-h-9 px-3 text-xs"
          onClick={() => {
            reset();
            onClose();
          }}
        >
          收起
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_MIME.join(",")}
          aria-label="上传查询图"
          data-testid="image-search-input"
          className="hidden"
          onChange={(event) => void onPick(event.target.files?.[0])}
        />
        <Button
          className="min-h-9 px-3 text-xs"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? "找样中…" : "选择查询图"}
        </Button>
        {previewUrl && (
          <img
            src={previewUrl}
            alt="查询图预览"
            className="h-12 w-12 rounded-md border border-line object-cover"
          />
        )}
        {busy && <Spinner label="正在上传并检索…" />}
        {meta && (
          <span data-testid="image-search-mode">
            <Badge tone={meta.semantic ? "info" : "neutral"}>
              {meta.mode === "caption"
                ? "按图像描述检索"
                : meta.semantic
                ? "看图找相似"
                : "演示模式"}
            </Badge>
          </span>
        )}
      </div>

      {error && (
        <p data-testid="image-search-status" className="text-xs text-ink-500">
          {error}
        </p>
      )}

      {matches.length > 0 && (
        <ul data-testid="image-search-results" className="grid gap-2 md:grid-cols-2">
          {matches.map((match) => {
            const thumb = match.matchedImageUrl ?? match.sample.primaryImageUrl ?? null;
            return (
              <li
                key={match.sample.id}
                data-testid="image-match"
                className="flex items-center gap-3 rounded-md border border-line bg-paper px-3 py-2"
              >
                {thumb ? (
                  <img
                    data-testid="image-match-thumb"
                    src={thumb}
                    alt={`${match.sample.name} 命中图`}
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-dashed border-line text-[10px] text-ink-400">
                    待补图
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink-900">{match.sample.name}</span>
                  <span className="block truncate text-xs text-ink-400">
                    {match.sample.code} · {match.sample.composition ?? "成分未填"}
                  </span>
                </span>
                <Badge tone="info">{Math.round(match.score * 100)}%</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
