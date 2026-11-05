import { redirect } from 'next/navigation';

// The console lives under /demo; the bare origin sends people there instead of a 404.
export default function RootPage(): never {
  redirect('/demo');
}
