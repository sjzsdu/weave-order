import { Module } from "@nestjs/common";
import { HttpModule } from "./http/http.module";

/** HTTP 面只暴露只读目录、工具调用与人类确认；写账本仍然只在 kernel。 */
@Module({
  imports: [HttpModule],
})
export class AppModule {}
