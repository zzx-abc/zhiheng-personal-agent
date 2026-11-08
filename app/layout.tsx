import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'知衡 · 投资个人智能体',description:'记住你的问题，让每一次判断有据可循。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
