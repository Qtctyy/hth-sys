import './globals.css';

export const metadata = {
  title: 'Ride Log',
  description: 'Track your transportation rides',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
