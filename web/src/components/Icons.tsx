// Line icons for navigation (24px grid, drawn in currentColor).
const P: Record<string, string> = {
  overview: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z',
  budget: 'M12 3a9 9 0 1 0 9 9h-9zM15 3.5A8 8 0 0 1 20.5 9H15z',
  goals: 'M5 21V4m0 0h11l-2 4 2 4H5',
  dashboard: 'M4 20V10m5.3 10V4m5.4 16v-7M20 20v-4',
  transactions: 'M4 7h13m0 0-3-3m3 3-3 3M20 17H7m0 0 3-3m-3 3 3 3',
  review: 'M9 12.5 11 14.5 15.5 10M12 3.5l7 3v5c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9v-5z',
  income: 'M3 7h18v10H3zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 10v4m12-4v4',
  mortgage: 'M3 10.5 12 4l9 6.5M5.5 9v11h13V9M10 20v-5h4v5',
  accounts: 'M3 9 12 4l9 5M4 20h16M6 10v7m4-7v7m4-7v7m4-7v7',
  recurring: 'M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7',
  forecast: 'M3 17l5-5 4 3 8-8M15 7h5v5',
  taxes: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  projection: 'M3 20h18M5 16l4-5 3 3 6-8M15 6h3v3',
  recap: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
}

export function Icon({ name, size = 20 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.7}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={P[name] || P.more} />
    </svg>
  )
}
