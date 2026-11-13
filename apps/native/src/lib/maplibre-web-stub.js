// Web stand-in for @maplibre/maplibre-react-native, which is native-only: its
// entry calls Object.create(NativeModules.MLRNModule) at import time, which is
// undefined under react-native-web and throws before the app renders.
//
// Metro resolves the package to this file on the web platform only. Every
// component renders nothing, and the imperative refs the turf screen uses are
// provided as no-ops so optional chaining stays safe.
import { forwardRef, useImperativeHandle } from "react";

const Nothing = () => null;

export const Map = forwardRef(function Map(_props, ref) {
  useImperativeHandle(ref, () => ({
    getZoom: () => 0,
    getBearing: () => 0,
    getBounds: () => [0, 0, 0, 0],
  }));
  return null;
});

export const Camera = forwardRef(function Camera(_props, ref) {
  useImperativeHandle(ref, () => ({
    setStop: () => {},
    jumpTo: () => {},
    easeTo: () => {},
    flyTo: () => {},
  }));
  return null;
});

export const GeoJSONSource = forwardRef(function GeoJSONSource(_props, ref) {
  useImperativeHandle(ref, () => ({
    getClusterExpansionZoom: () => Promise.resolve(14),
    getData: () => Promise.resolve({ type: "FeatureCollection", features: [] }),
  }));
  return null;
});

export const ViewAnnotation = Nothing;
export const Layer = Nothing;
export const VectorSource = Nothing;
export const NativeUserLocation = Nothing;
