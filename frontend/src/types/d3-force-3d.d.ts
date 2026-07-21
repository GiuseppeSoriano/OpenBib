// d3-force-3d ships no TypeScript types; we only need forceCollide.
declare module "d3-force-3d" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function forceCollide(radius?: number | ((node: any) => number)): any;
}
