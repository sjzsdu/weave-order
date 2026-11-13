import { Text, View } from "@tarojs/components";
import type { PropsWithChildren } from "react";
import { useRef, useState } from "react";

/**
 * 审批卡手势：左滑驳回、右滑通过。
 * 阈值 96px；按钮始终保留（不能要求用户必须先学会手势）。
 */

function pointX(event: unknown): number {
  const touches = (event as { touches?: Array<{ clientX?: number }> }).touches;
  return touches?.[0]?.clientX ?? 0;
}

export function SwipeCard({
  children,
  onApprove,
  onReject,
  disabled = false,
}: PropsWithChildren<{
  onApprove: () => void;
  onReject: () => void;
  disabled?: boolean;
}>) {
  const startX = useRef(0);
  const [dx, setDx] = useState(0);
  const THRESHOLD = 96;

  return (
    <View className="swipe-wrap">
      <View className={`swipe-hint swipe-left${dx > 24 ? " show" : ""}`}>
        <Text>批准</Text>
      </View>
      <View className={`swipe-hint swipe-right${dx < -24 ? " show" : ""}`}>
        <Text>驳回</Text>
      </View>
      <View
        className="swipe-card"
        style={{ transform: `translateX(${dx}px)` }}
        onTouchStart={(event) => {
          if (!disabled) startX.current = pointX(event);
        }}
        onTouchMove={(event) => {
          if (disabled) return;
          const next = pointX(event) - startX.current;
          setDx(Math.max(-140, Math.min(140, next)));
        }}
        onTouchEnd={() => {
          if (disabled) return;
          if (dx >= THRESHOLD) onApprove();
          else if (dx <= -THRESHOLD) onReject();
          setDx(0);
        }}
      >
        {children}
      </View>
    </View>
  );
}
