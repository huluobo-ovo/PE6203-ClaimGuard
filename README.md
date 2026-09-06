# ClaimGuard Reimbursement Review

成员5原型交付 · PE6203 · 2026-09-06

## 本地运行
Node.js 22.13以上（建议Node 24或26），npm ci，然后npm run dev。使用控制台给出的地址。生产构建 npm run build。部署由Sites管理，元数据见.openai/hosting.json。

## 模式
演示模式仅加载内置开发票据的已知字段并执行演示规则，不调用模型。自有PDF/JPG/PNG在真实模式下通过服务端发送到Gemini，最大10 MB。会话密钥在页面内存中，刷新清除，不保存至日志或本地存储；只接受固定Google API目标。网站不使用数据库保存票据。

A：一次模型调用、原始票据、极简提示、无政策。B：一次调用、全部18条教学政策。C：提取→确认→校验→检索→预审→说明。对比使用相同票据、上下文、模型、temperature=0及最大输出token设置。C比较运行不进行人工更正；各模块最多一次格式重试，并记录每次尝试。

## 验证
node --test tests/engine.test.mjs
npx tsc --noEmit
npm run build

25项逻辑检查已通过，另有真实浏览器演示流程与4项API输入检查。由于没有有效模型密钥，尚未进行真实Gemini请求或60次正式比较，不应将演示记录报告为AI评估结果。

## 限制
- 政策是教学制度，不是实际公司或法律税务规则。
- 财务按钮下载人工审核材料，不会向真实财务系统发送申请。
- 审批和重复核查为用户填写的证据引用，未经本站独立核验，最终由财务核实。
- PDF文件头校验不能发现所有损坏或加密问题；真实模型读取失败会显示错误并保留人工处理入口。图片在浏览器解码检查。
- 运行记录只在当前会话内存中，导出JSON后保存；刷新即清除。
- WebMCP进行了兼容性检测与生命周期清理；浏览器没有标准实现时不影响网页。未完成原生WebMCP运行验证。

## 来源
交付包member_3_4。Gemini请求依据Google官方generateContent、图片、PDF与结构化输出文档：
https://ai.google.dev/api/generate-content
https://ai.google.dev/gemini-api/docs/document-processing
https://ai.google.dev/gemini-api/docs/structured-output
