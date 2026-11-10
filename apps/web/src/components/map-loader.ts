import { lazy } from "react";

export const loadMapView = () => import("./MapView.tsx");

export const LazyMapView = lazy(loadMapView);
