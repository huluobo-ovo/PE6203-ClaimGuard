import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'ClaimGuard · Reimbursement Review',description:'Upload receipts, confirm fields, and review policy evidence and actions.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
