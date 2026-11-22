import { configureStore } from '@reduxjs/toolkit';
import session from './sessionSlice';
import chat from './chatSlice';

export const makeStore = () =>
  configureStore({
    reducer: { session, chat },
    middleware: (getDefault) => getDefault({ serializableCheck: false }),
  });

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
