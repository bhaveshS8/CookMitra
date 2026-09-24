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
  // Write to the chosen store AND clear the other one, so a stale token in
  // the opposite store can never resurrect an old session.
  const store = persistent ? localStorage : sessionStorage;
  const other = persistent ? sessionStorage : localStorage;
  try {
    other.removeItem(TOKEN_KEY);
    other.removeItem(USER_KEY);
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

// NOTE: RTK serializes plain thunk throws (dropping axios `err.response`)
// and `.unwrap()` rethrows that husk — so call sites reading
// `err.response?.data` (Register page, Home quick form, Login) would only
// ever see generic failures. Thunks below preserve the server's structured
// error via rejectWithValue instead, so `.unwrap()` throws it verbatim.
const preserveAuthError = (err) => ({
  response: {
    status: err?.response?.status,
    data: err?.response?.data,
  },
  message: err?.message,
  code: err?.code,
});

export const loginUser = createAsyncThunk(
  "auth/login",
  async ({ email, password, rememberMe = true }, { rejectWithValue }) => {
    try {
      const cleanEmail = String(email || "").trim().toLowerCase();
      if (!cleanEmail || !password) {
        const err = new Error("Email and password are required");
        err.response = { status: 400, data: { message: "Email and password are required" } };
        throw err;
      }
      const response = await API.post("/auth/login", {
        email: cleanEmail,
        password,
        rememberMe: rememberMe !== false,
      });
      const { token, user } = response.data;
      const normalized = normalizeUser(user);
      persist(token, normalized, rememberMe !== false);
      return { token, user: normalized };
    } catch (err) {
      return rejectWithValue(preserveAuthError(err));
    }
  }
);

export const registerUser = createAsyncThunk("auth/register", async (data, { rejectWithValue }) => {
  // Normalize at the boundary: backend lowercases email but the lookup +
  // validators expect clean input; role must be UPPERCASE per spec §17.
  const payload = {
    ...data,
    email: String(data?.email || "").trim().toLowerCase(),
    name: String(data?.name || "").trim(),
    phone: String(data?.phone || data?.mobile || "").trim(),
    role: String(data?.role || "customer").toUpperCase(),
  };
  try {
    const response = await API.post("/auth/register", payload);
    const { token, user } = response.data;
    const normalized = normalizeUser(user);
    persist(token, normalized);
    return { token, user: normalized };
  } catch (err) {
    return rejectWithValue(preserveAuthError(err));
  }
});

export const googleLoginUser = createAsyncThunk(
  "auth/googleLogin",
  async ({ idToken, role }, { rejectWithValue }) => {
    try {
      const response = await API.post("/auth/google", { idToken, role });
      const { token, user } = response.data;
      const normalized = normalizeUser(user);
      persist(token, normalized);
      return { token, user: normalized };
    } catch (err) {
      return rejectWithValue(preserveAuthError(err));
    }
  }
);

// Sign out on both sides: clear the httpOnly session cookie server-side
// (best-effort — offline logout still clears local state) and wipe stored
// credentials locally.
export const logoutUser = createAsyncThunk("auth/logout", async (_, { dispatch }) => {
  try {
    await API.post("/auth/logout");
  } catch {
    // offline or already expired — local wipe below still signs the user out
  }
  dispatch(logout());
  return true;
});

// Revalidate the stored session against the server (suspended/deleted
// accounts are logged out immediately instead of lingering in storage).
export const fetchCurrentUser = createAsyncThunk("auth/me", async (_, { rejectWithValue }) => {
  try {
    const response = await API.get("/auth/me");
    const normalized = normalizeUser(response.data);
    try {
      const store = localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage;
      store.setItem(USER_KEY, JSON.stringify(normalized));
    } catch {
      // ignore
    }
    return { user: normalized };
  } catch (err) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      clearStored();
    }
    return rejectWithValue(err?.response?.data?.message || "Session expired");
  }
});

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
      // rejectWithValue payloads carry the server message; plain AxiosError
      // serializations fall back to action.error as before.
      state.error =
        action.payload?.response?.data?.message ||
        action.payload?.message ||
        action.error?.message ||
        "Authentication failed";
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
      .addCase(googleLoginUser.rejected, onRejected)
      .addCase(fetchCurrentUser.fulfilled, (state, action) => {
        state.loading = false;
        state.user = action.payload.user;
        state.error = null;
      })
      .addCase(fetchCurrentUser.rejected, (state, action) => {
        state.loading = false;
        // Only wipe the session when the server rejected it — a network
        // blip must not log the user out.
        if (action.payload === "Session expired" || /blocked by an administrator|no longer exists|not valid/i.test(String(action.payload))) {
          state.user = null;
          state.token = null;
        }
        state.error = null;
      });
  },
});

export const { logout, updateUser, clearAuthError } = authSlice.actions;
export default authSlice.reducer;
