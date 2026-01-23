import { Controller, Post, Body, Get, UseGuards, Req, Headers } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type { LoginDto, RegisterDto, AuthResponse } from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GetUser } from './decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Función para obtener la IP real del cliente
  private getClientIp(req: Request): string {
    // Revisar headers de proxies/load balancers
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
      return ips.trim();
    }
    
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }
    
    // Cloudflare
    const cfConnectingIp = req.headers['cf-connecting-ip'];
    if (cfConnectingIp) {
      return Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    }
    
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Headers('user-agent') userAgent: string,
  ): Promise<AuthResponse> {
    const ip = this.getClientIp(req);
    return this.authService.register(dto, ip, userAgent);
  }

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Headers('user-agent') userAgent: string,
  ): Promise<AuthResponse> {
    const ip = this.getClientIp(req);
    return this.authService.login(dto, ip, userAgent);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(
    @GetUser() user: UserEntity,
    @Req() req: Request,
    @Headers('user-agent') userAgent: string,
  ) {
    const ip = this.getClientIp(req);
    await this.authService.logout(user.id, ip, userAgent);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@GetUser() user: UserEntity) {
    return {
      id: user.id,
      email: user.email,
      nombre: user.nombre,
      numero: user.numero,
      isAdmin: user.isAdmin,
    };
  }

  @Get('refresh')
  @UseGuards(JwtAuthGuard)
  async refreshUser(@GetUser() user: UserEntity) {
    // Obtener datos frescos del usuario desde la base de datos
    const freshUser = await this.authService.validateUser(user.id);
    return {
      id: freshUser.id,
      email: freshUser.email,
      nombre: freshUser.nombre,
      numero: freshUser.numero,
      isAdmin: freshUser.isAdmin,
    };
  }

  @Get('validate-admin')
  @UseGuards(JwtAuthGuard)
  async validateAdmin(@GetUser() user: UserEntity) {
    // Obtener datos frescos del usuario desde la base de datos para validar permisos actuales
    const freshUser = await this.authService.validateUser(user.id);
    return {
      isAdmin: freshUser.isAdmin,
      hasPermission: freshUser.isAdmin,
      message: freshUser.isAdmin 
        ? 'Acceso autorizado al panel de administración' 
        : 'Acceso denegado. Se requieren permisos de administrador.'
    };
  }
}

