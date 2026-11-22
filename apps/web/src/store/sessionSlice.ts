import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { PublicUser } from '@ghostchat/shared-types';

export interface SessionState {
  user: PublicUser | null;
  status: 'loading' | 'anonymous' | 'authenticated';
  error: string | null;
}

const initialState: SessionState = { user: null, status: 'loading', error: null };

const slice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    setUser(state, action: PayloadAction<PublicUser>) {
      state.user = action.payload;
      state.status = 'authenticated';
      state.error = null;
    },
    clearUser(state) {
      state.user = null;
      state.status = 'anonymous';
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setStatus(state, action: PayloadAction<SessionState['status']>) {
      state.status = action.payload;
    },
  },
});

export const { setUser, clearUser, setError, setStatus } = slice.actions;
export default slice.reducer;
