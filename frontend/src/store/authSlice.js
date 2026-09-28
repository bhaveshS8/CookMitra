import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import API from "../api/axios";

const TOKEN_KEY = "token";
const USER_KEY = "user";

// Backend stores spec-UPPERCASE roles (CUSTOMER/COOK/ADMIN, §17) while the
// whole frontend compares lowercase ("customer"/"cook"/"admin"). Normalize
// once at the auth boundary so every screen, guard and redirect keeps working
// regardless of what case the API (or an old localStorage entry) returns.
export const normalizeRole = (role) => {
  if (typeof role !== "string") return role;
  const lower = role.toLowerCase();
  return ["customer", "cook", "admin"].includes(lower) ? lower : role;
};

const normalizeUser = (user) => {
  if (!user || typeof user !== "object") return user;
  if (typeof user.role === "string") {
    const lower = normalizeRole(user.role);
    if (user.role !== lower) return { ...user, role: lower };
  }
  return user;
};

const loadStored = () => {
  try {
    // Persistent session first, then session-only ("Keep me signed in"
    // unchecked stores the token in sessionStorage instead).
    const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    const rawUser =
      localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY);
    return {
      token: token || null,
      user: rawUser ? normalizeUser(JSON.parse(rawUser)) : null,
    };
  } catch {
    return { token: null, user: null };
  }
};

const persist = (token, user, persistent = true) => {
  const store = persistent ? localStorage : sessionStorage;
  try {
    if (token) store.setItem(TOKEN_KEY, token);
    if (user) store.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // storage unavailable — session still works for this visit
  }
};

const clearStored = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
};

const stored = loadStored();

// NOTE: thunks re-throw the original axios error (instead of
// rejectWithValue) so existing call sites keep reading
// `err.response?.data?.message` unchanged via `.unwrap()`.
export const loginUser = createAsyncThunk(
  "auth/login",
  async ({ email, password, rememberMe = true }) => {
    const response = await API.post("/auth/login", { email, password });
    const { token, user } = response.data;
    const normalized = normalizeUser(user);
    persist(token, normalized, rememberMe !== false);
    return { token, user: normalized };
  }
);

export const registerUser = createAsyncThunk("auth/register", async (data) => {
  const response = await API.post("/auth/register", data);
  const { token, user } = response.data;
  const normalized = normalizeUser(user);
  persist(token, normalized);
  return { token, user: normalized };
});

export const googleLoginUser = createAsyncThunk(
  "auth/googleLogin",
  async ({ idToken, role }) => {
    const response = await API.post("/auth/google", { idToken, role });
    const { token, user } = response.data;
    const normalized = normalizeUser(user);
    persist(token, normalized);
    return { token, user: normalized };
  }
);

const authSlice = createSlice({
  name: "auth",
  initialState: {
    user: stored.user,
    token: stored.token,
    // Synchronously initialised from localStorage (the old context did the
    // same read in an effect). No async boot step, so no stuck loaders.
    loading: false,
    error: null,
  },
  reducers: {
    logout(state) {
      clearStored();
      state.user = null;
      state.token = null;
      state.error = null;
    },
    updateUser(state, action) {
      if (!state.user) return;
      state.user = normalizeUser({ ...state.user, ...action.payload });
      try {
        // Write back to whichever store holds this session.
        const store = localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage;
        store.setItem(USER_KEY, JSON.stringify(state.user));
      } catch {
        // ignore
      }
    },
    clearAuthError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    const onPending = (state) => {
      state.loading = true;
      state.error = null;
    };
    const onFulfilled = (state, action) => {
      state.loading = false;
      state.token = action.payload.token;
      state.user = action.payload.user;
      state.error = null;
    };
    const onRejected = (state, action) => {
      state.loading = false;
      state.error = action.error?.message || "Authentication failed";
    };
    builder
      .addCase(loginUser.pending, onPending)
      .addCase(loginUser.fulfilled, onFulfilled)
      .addCase(loginUser.rejected, onRejected)
      .addCase(registerUser.pending, onPending)
      .addCase(registerUser.fulfilled, onFulfilled)
      .addCase(registerUser.rejected, onRejected)
      .addCase(googleLoginUser.pending, onPending)
      .addCase(googleLoginUser.fulfilled, onFulfilled)
      .addCase(googleLoginUser.rejected, onRejected);
  },
});

export const { logout, updateUser, clearAuthError } = authSlice.actions;
export default authSlice.reducer;
