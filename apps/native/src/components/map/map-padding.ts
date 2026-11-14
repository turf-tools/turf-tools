export type MapPadding = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

// The camera centre sits inside this inset. Keep the map's fitted
// content and the locate/cluster stops on the same values.
export function mapPadding(bottomInset: number): MapPadding {
  return { top: 60, bottom: 60 + bottomInset, left: 40, right: 40 };
}
