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

// ── Response interceptor: auto-logout on 401, subscription block on 402 ──────
// Only auto-logout on 401 from authenticated routes, NOT from login/change-password
// endpoints — those should let the screen handle the error and show it to the user.
const AUTH_ENDPOINTS = ['/api/auth/login/student', '/api/auth/student/change-password'];

apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError) => {
    const url = error.config?.url ?? '';
    const isAuthEndpoint = AUTH_ENDPOINTS.some((ep) => url.includes(ep));

    if (error.response?.status === 401 && !isAuthEndpoint) {
      // Token expired or invalid on a regular route — clear auth state
      useAuthStore.getState().logout();
    }

    return Promise.reject(error);
  }
);

export default apiClient;
