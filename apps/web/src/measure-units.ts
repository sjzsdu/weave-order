"use client";

import { useQuery } from "@tanstack/react-query";
import { DEFAULT_MEASURE_UNITS } from "@weave-order/schema";
import type { MeasureUnits } from "@weave-order/schema";
import { useApi } from "@/providers";

/**
 * 租户默认度量单位（克重 / 门幅）。
 *
 * 只用来给录入面预选单位：数值永远由人填，单位只是默认值。
 * 读不到就用行业默认（g/m² 与 cm）—— 录入面不能因为一个设置读不到就卡住。
 */
export function useMeasureUnits(): MeasureUnits {
  const api = useApi();
  const query = useQuery({
    queryKey: ["settings", "measure-units"],
    queryFn: () => api.measureUnits(),
    staleTime: 5 * 60_000,
  });
  return query.data ?? DEFAULT_MEASURE_UNITS;
}
