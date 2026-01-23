import { Injectable, UnauthorizedException, ConflictException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserEntity } from '../users/user.entity';
import type { LoginDto, RegisterDto, AuthResponse } from './dto/auth.dto';
import { AdminService } from '../admin/admin.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly jwtService: JwtService,
    @Inject(forwardRef(() => AdminService))
    private readonly adminService: AdminService,
  ) {}

  async register(dto: RegisterDto, ipAddress?: string, userAgent?: string): Promise<AuthResponse> {
    // Verificar si el email ya existe
    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('El email ya está registrado');
    }

    // Hash de la contraseña
    const hashedPassword = await bcrypt.hash(dto.password, 10);

    // Crear usuario
    const user = this.userRepo.create({
      email: dto.email,
      password: hashedPassword,
      nombre: dto.nombre,
      numero: dto.numero,
    });

    const savedUser = await this.userRepo.save(user);

    // Generar token
    const token = this.jwtService.sign({ userId: savedUser.id, email: savedUser.email });

    // Registrar actividad de login con IP y User-Agent
    await this.adminService.logActivity(savedUser.id, 'login', ipAddress, userAgent);

    return {
      token,
      user: {
        id: savedUser.id,
        email: savedUser.email,
        nombre: savedUser.nombre,
        numero: savedUser.numero,
        isAdmin: savedUser.isAdmin,
      },
    };
  }

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string): Promise<AuthResponse> {
    // Buscar usuario
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Verificar contraseña
    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Generar token
    const token = this.jwtService.sign({ userId: user.id, email: user.email });

    // Registrar actividad de login con IP y User-Agent
    await this.adminService.logActivity(user.id, 'login', ipAddress, userAgent);

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        numero: user.numero,
        isAdmin: user.isAdmin,
      },
    };
  }

  async logout(userId: number, ipAddress?: string, userAgent?: string): Promise<void> {
    await this.adminService.logActivity(userId, 'logout', ipAddress, userAgent);
  }

  async validateUser(userId: number): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }
    return user;
  }
}

