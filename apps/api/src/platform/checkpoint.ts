import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Pool } from "pg";

/**
 * LangGraph 的 PostgreSQL 检查点。
 *
 * 表结构由官方 saver 的 setup() 管理（checkpoints / checkpoint_blobs /
 * checkpoint_writes），与业务表的 Drizzle 迁移互不干扰。
 * setup() 幂等，可重复调用。
 */
export async function createPostgresCheckpointer(pool: Pool): Promise<PostgresSaver> {
  const checkpointer = new PostgresSaver(pool);
  await checkpointer.setup();
  return checkpointer;
}
