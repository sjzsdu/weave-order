"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { FabricSample } from "@weave-order/schema";
import { Badge, Button, EmptyState, Spinner, cn } from "@weave-order/ui";
import { useApi } from "@/providers";
import { useMounted } from "@/use-mounted";
import { SampleEditor } from "@/sample-editor";
import { SampleImport } from "@/sample-import";
import { SampleDrawer } from "@/sample-drawer";
import { SampleImageSearch } from "@/sample-image-search";
import { thumbBadge } from "@/sample-image-status";

type StatusFilter = "ACTIVE" | "ARCHIVED" | "ALL";

/**
 * 样品图墙：桌面 4~5 列、移动 2 列。
 * 缩略图走服务端派生的 `thumbUrl`（`_320.webp`，本地 MinIO 同样成立）；
 * 派生失败时接口回退原图并带 `thumbStatus=failed`，卡片必须显式标注。
 * 无图卡片显示「待补图」并提供补图入口。
 */
export default function SamplesPage() {
  const mounted = useMounted();
  if (!mounted) {
    return <div className="p-6 text-sm text-ink-400">正在连接织序…</div>;
  }
  return <SamplesWall />;
}

function SamplesWall() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSample, setEditorSample] = useState<FabricSample | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [openSampleId, setOpenSampleId] = useState<string | null>(null);
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  // 保存成功后的动作级反馈：带下一步，而不是让图墙悄悄多一格。
  const [saved, setSaved] = useState<{ id: string; name: string; code: string } | null>(null);

  // 搜索防抖：输入停下来再打后端，避免每个按键一次 ILIKE。
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ["samples", "wall", { query, category, status }],
    queryFn: ({ pageParam }) =>
      api.listSamplesPage({
        query: query || null,
        category: category || null,
        status,
        cursor: pageParam,
        limit: 24,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });

  const pages = list.data?.pages ?? [];
  const samples = useMemo(() => pages.flatMap((page) => page.samples), [pages]);
  const lastPage = pages[pages.length - 1];
  const categories = lastPage?.categories ?? [];
  const remaining = lastPage?.remaining ?? 0;
  const total = lastPage?.total ?? 0;

  const openCreate = () => {
    setEditorSample(null);
    setEditorOpen(true);
  };
  // 深链入口：开张清单、⌘K 命令与全景空状态直接打开新建或导入。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") {
      setEditorSample(null);
      setEditorOpen(true);
    }
    if (params.get("import") === "1") setImportOpen(true);
  }, []);
  const openEdit = (sample: FabricSample) => {
    setEditorSample(sample);
    setEditorOpen(true);
  };
  // 样品数变了，全景的统计也要跟着变，否则切回去还是旧数字。
  const refreshAll = () => {
    void list.refetch();
    void queryClient.invalidateQueries({ queryKey: ["panorama"] });
  };

  const narrowed = query !== "" || category !== "" || status !== "ACTIVE";

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <nav className="flex items-center gap-1 text-xs text-ink-400">
            <Link href="/panorama" className="hover:text-ink-900">
              业务全景
            </Link>
            <span>/</span>
            <span className="text-ink-700">样品</span>
          </nav>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">样品库</h1>
          <p className="mt-1 text-sm text-ink-400">
            一面图墙：点开看大图与规格；没有图的样品会明确标「待补图」。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            data-testid="open-image-search"
            onClick={() => setImageSearchOpen((open) => !open)}
          >
            以图找样
          </Button>
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            导入 CSV
          </Button>
          <Button onClick={openCreate}>新建样品</Button>
        </div>
      </header>

      {imageSearchOpen && <SampleImageSearch onClose={() => setImageSearchOpen(false)} />}

      {importedCount !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-moss-600/30 bg-moss-600/10 px-3 py-2 text-sm text-moss-600"
        >
          <span>已导入 {importedCount} 个样品，全部落库。</span>
          <span className="text-xs text-ink-400">导入不带图，点开卡片可以补图。</span>
          <button
            type="button"
            onClick={() => setImportedCount(null)}
            aria-label="关闭提示"
            className="ml-auto text-ink-400 hover:text-ink-900"
          >
            ✕
          </button>
        </div>
      )}

      <section className="grid gap-2 rounded-lg border border-line bg-surface px-3 py-3 md:grid-cols-[1fr_auto_auto]">
        <input
          className="input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜编码 / 品名 / 成分"
          aria-label="搜索样品"
        />
        <select
          className="input md:w-40"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          aria-label="品类筛选"
        >
          <option value="">全部品类</option>
          {categories.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <select
          className="input md:w-36"
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          aria-label="状态筛选"
        >
          <option value="ACTIVE">在售</option>
          <option value="ARCHIVED">已归档</option>
          <option value="ALL">全部状态</option>
        </select>
      </section>

      <div className="flex items-center justify-between text-xs text-ink-400">
        <span>共 {total} 个样品</span>
        {query && <span>筛选：{query}</span>}
      </div>

      {list.isLoading && <Spinner label="正在加载样品图墙…" />}
      {list.isError && (
        <EmptyState
          title="样品图墙不可用"
          description={list.error instanceof Error ? list.error.message : "请稍后重试"}
        />
      )}
      {!list.isLoading &&
        samples.length === 0 &&
        (narrowed ? (
          <EmptyState
            title="没有匹配的样品"
            description="换个关键词，或把筛选清掉。"
            actions={
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch("");
                  setCategory("");
                  setStatus("ACTIVE");
                }}
              >
                清空筛选
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="还没有样品"
            description="手动建一个，或导入 CSV（可先下载模板）。导入后回来补图。"
            actions={
              <>
                <Button onClick={openCreate}>新建样品</Button>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  导入 CSV
                </Button>
              </>
            }
          />
        ))}

      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        {samples.map((sample) => (
          <SampleCard
            key={sample.id}
            sample={sample}
            onOpen={() => setOpenSampleId(sample.id)}
            onFillImage={() => openEdit(sample)}
          />
        ))}
      </ul>

      {remaining > 0 && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? "加载中…" : `还有 ${remaining} 个，加载更多`}
          </Button>
        </div>
      )}
      {remaining === 0 && samples.length > 0 && (
        <p className="text-center text-xs text-ink-400">已经到底了</p>
      )}

      <SampleEditor
        open={editorOpen}
        sample={editorSample}
        onClose={() => setEditorOpen(false)}
        onSaved={(sample) => {
          refreshAll();
          setSaved({ id: sample.id, name: sample.name, code: sample.code });
        }}
      />
      {importOpen && (
        <SampleImport
          onClose={() => setImportOpen(false)}
          onImported={(count) => {
            setImportedCount(count);
            refreshAll();
          }}
        />
      )}
      {saved && (
        <SampleSavedToast
          sample={saved}
          onDismiss={() => setSaved(null)}
          onOpen={() => {
            setSaved(null);
            setOpenSampleId(saved.id);
          }}
        />
      )}
      {openSampleId && (
        <SampleDrawer
          sampleId={openSampleId}
          onClose={() => setOpenSampleId(null)}
          onEdit={(sample) => {
            setOpenSampleId(null);
            openEdit(sample);
          }}
        />
      )}
    </div>
  );
}

function SampleCard({
  sample,
  onOpen,
  onFillImage,
}: {
  sample: FabricSample;
  onOpen: () => void;
  onFillImage: () => void;
}) {
  const primary = sample.images?.find((image) => image.isPrimary) ?? sample.images?.[0] ?? null;
  const thumb = primary?.thumbUrl ?? primary?.url ?? sample.primaryImageUrl ?? null;
  const badge = thumbBadge(primary?.thumbStatus, primary?.thumbError);

  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        {thumb ? (
          <span className="relative block">
            <img
              src={thumb}
              alt={`${sample.name} 主图`}
              loading="lazy"
              decoding="async"
              className="aspect-square w-full bg-paper object-cover"
            />
            {badge && (
              // 只有主图缩略图没就绪时才加角标：失败时接口回退的是原图，
              // 不能让用户以为「这张大图就是图墙用的缩略图」。
              <span
                data-testid="sample-thumb-badge"
                title={badge.reason ?? (badge.tone === "danger" ? "当前显示原图" : "缩略图派生中")}
                className={cn(
                  "absolute bottom-1 left-1 rounded px-1.5 py-0.5 text-[10px] text-white",
                  badge.tone === "danger" ? "bg-rose-700/85" : "bg-amber-600/90",
                )}
              >
                {badge.label}
              </span>
            )}
          </span>
        ) : (
          <span className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-paper text-xs text-ink-400">
            <span>待补图</span>
            <span className="text-[10px] text-ink-400/70">点卡片补图</span>
          </span>
        )}
        <span className="block px-3 py-2">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink-900">{sample.name}</span>
            <Badge tone="neutral">{sample.status === "ACTIVE" ? sample.code : "已归档"}</Badge>
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-400">
            {[sample.composition, sample.weight].filter(Boolean).join(" · ") || "规格未填"}
          </span>
        </span>
      </button>
      {!thumb && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onFillImage}
            className={cn(
              "w-full rounded-md border border-dashed border-line py-1 text-xs text-indigo-600",
              "hover:border-indigo-600",
            )}
          >
            一键补图
          </button>
        </div>
      )}
    </li>
  );
}

/** 动作级 toast：不阻塞，带下一步，而不是让图墙悄悄多一格（WAN-149）。 */
function SampleSavedToast({
  sample,
  onDismiss,
  onOpen,
}: {
  sample: { id: string; name: string; code: string };
  onDismiss: () => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-[min(92vw,640px)] flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-card"
    >
      <span className="font-medium text-ink-900">样品「{sample.name}」已建</span>
      <span className="text-xs text-ink-400">{sample.code}</span>
      <Link
        href={`/today?intent=${encodeURIComponent(`用${sample.name}报价：`)}`}
        className="text-indigo-600 underline underline-offset-2"
      >
        用它报价 →
      </Link>
      <button type="button" onClick={onOpen} className="text-ink-700 underline underline-offset-2">
        补图 / 看规格
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="ml-auto text-ink-400 hover:text-ink-900"
      >
        ✕
      </button>
    </div>
  );
}
