import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { useAuthStore } from '../store/authStore';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL;

if (!BASE_URL) {
  throw new Error('EXPO_PUBLIC_API_URL is not defined. Check your .env file.');
}

const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Token-Type': 'student',
  },
});

// ── Request interceptor: attach auth token ────────────────────────────────────
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = useAuthStore.getState().token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// ── Response interceptor: handle auth errors ──────────────────────────────────
// 401 means the token was explicitly revoked server-side (logout or password
// change). Since student tokens are long-lived (no expiry), a 401 on a
// non-auth endpoint is a genuine revocation signal — log out cleanly.
// Auth endpoints themselves handle their own errors; don't double-logout there.
const AUTH_ENDPOINTS = [
  '/api/auth/login/student',
  '/api/auth/student/change-password',
  '/api/auth/student/forgot-password',
  '/api/auth/student/verify-otp',
  '/api/auth/student/reset-password-otp',
];

apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError) => {
    const url = error.config?.url ?? '';
    const isAuthEndpoint = AUTH_ENDPOINTS.some((ep) => url.includes(ep));

    // Only logout on 401 from a non-auth endpoint — this means the server
    // has explicitly revoked the token (password change / admin forced logout).
    // Network errors or server errors do NOT trigger a logout.
    if (error.response?.status === 401 && !isAuthEndpoint) {
      useAuthStore.getState().logout();
    }

    return Promise.reject(error);
  }
);

export default apiClient;
