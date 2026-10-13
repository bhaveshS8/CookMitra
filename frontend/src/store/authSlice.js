import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import API from "../api/axios";

const TOKEN_KEY = "token";
const USER_KEY = "user";

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
  const other = persistent ? sessionStorage : localStorage;
  try {
    other.removeItem(TOKEN_KEY);
    other.removeItem(USER_KEY);
    if (token) store.setItem(TOKEN_KEY, token);
    if (user) store.setItem(USER_KEY, JSON.stringify(user));
  } catch {
  }
};

const clearStored = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  } catch {
  }
};

const stored = loadStored();

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
  async ({ idToken, role, referralCode }, { rejectWithValue }) => {
    try {
      const response = await API.post("/auth/google", { idToken, role, ...(referralCode ? { referralCode } : {}) });
      const { token, user } = response.data;
      const normalized = normalizeUser(user);
      persist(token, normalized);
      return { token, user: normalized };
    } catch (err) {
      return rejectWithValue(preserveAuthError(err));
    }
  }
);

export const logoutUser = createAsyncThunk("auth/logout", async (_, { dispatch }) => {
  try {
    await API.post("/auth/logout");
  } catch {
  }
  dispatch(logout());
  return true;
});

export const fetchCurrentUser = createAsyncThunk("auth/me", async (_, { rejectWithValue }) => {
  try {
    const response = await API.get("/auth/me");
    const normalized = normalizeUser(response.data);
    try {
      const store = localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage;
      store.setItem(USER_KEY, JSON.stringify(normalized));
    } catch {
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
        const store = localStorage.getItem(TOKEN_KEY) ? localStorage : sessionStorage;
        store.setItem(USER_KEY, JSON.stringify(state.user));
      } catch {
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
