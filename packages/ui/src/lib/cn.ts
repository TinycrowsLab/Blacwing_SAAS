import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins conditional class names and resolves Tailwind conflicts; the last conflicting class wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
