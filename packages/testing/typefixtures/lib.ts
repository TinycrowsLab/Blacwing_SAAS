// lib = ["ES2023"], types = ["node"]: server code sees Node 22 and ES2023 only. No DOM globals,
// and no APIs newer than the Node 22 baseline, unless a package (only apps/web) opts in.

export const sortedCopy = [3, 1, 2].toSorted((left, right) => left - right);
export const lastEven = [1, 2, 3, 4].findLast((value) => value % 2 === 0);

// @ts-expect-error TS2584 lib: DOM globals are not available to server code
export const title: string = document.title;

// @ts-expect-error TS2550 lib: ES2024 library additions are not part of the ES2023 baseline
export const grouped = Object.groupBy([1, 2, 3], (value: number) =>
  value % 2 === 0 ? 'even' : 'odd',
);
