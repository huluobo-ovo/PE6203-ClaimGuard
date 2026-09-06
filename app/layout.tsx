import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'ClaimGuard · 报销预审助手',description:'上传票据、确认字段、查看教学报销政策与预审依据。最终审核由财务人员完成。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
