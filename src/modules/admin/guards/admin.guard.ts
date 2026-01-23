import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../users/user.entity';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Usuario no autenticado');
    }

    const fullUser = await this.userRepo.findOne({ where: { id: user.id } });
    
    if (!fullUser || !fullUser.isAdmin) {
      throw new ForbiddenException('Acceso denegado. Se requieren permisos de administrador.');
    }

    return true;
  }
}
