import { createContext, useContext } from 'react';
import { TOUR_STEPS } from './tourSteps';

// Context + hook for the guided tour, split out from TourProvider so the provider
// file only exports a component (keeps React Fast Refresh happy).

export const TourCtx = createContext(null);

// Inert value when there's no provider (e.g. a non-demo build), so useTour()
// consumers never have to null-check.
const INERT = {
  running: false,
  index: -1,
  step: null,
  total: TOUR_STEPS.length,
  start() {},
  stop() {},
  next() {},
  back() {},
};

export function useTour() {
  return useContext(TourCtx) || INERT;
}
