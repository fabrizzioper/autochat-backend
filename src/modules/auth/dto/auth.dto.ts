export interface LoginDto {
  email: string;
  password: string;
}

export interface RegisterDto {
  email: string;
  password: string;
  nombre: string;
  numero: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: number;
    email: string;
    nombre: string;
    numero: string;
  };
}

