import type { Metadata } from 'next';
import { brand } from '@/config/brand';
import './globals.css';
export const metadata: Metadata = {
  applicationName: brand.name,
  title: `${brand.name} · Know what you hold`,
  description: 'Read public Solana holdings, understand Jupiter Lend loan risk, and model a read-only protection plan.',
  icons: {
    icon: '/brand/positionlayer-layer-mark.png',
    apple: '/brand/positionlayer-layer-mark.png',
  },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
