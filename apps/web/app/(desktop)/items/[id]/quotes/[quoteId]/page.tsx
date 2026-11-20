"use client";

import { useParams } from "next/navigation";
import { EmptyState } from "@weave-order/ui";
import { QuoteWorkbench } from "@/quote-workbench";

export default function ItemQuotePage() {
  const params = useParams<{ id: string; quoteId: string }>();
  if (!params?.id || !params.quoteId) {
    return <EmptyState title="找不到这份报价" description="请从事项详情重新进入" />;
  }
  return <QuoteWorkbench itemId={params.id} quoteId={params.quoteId} />;
}
