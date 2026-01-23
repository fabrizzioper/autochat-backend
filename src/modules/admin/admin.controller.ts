import { Controller, Get, Param, Query, UseGuards, ParseIntPipe, Put, Body } from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * Dashboard resumen para admin
   */
  @Get('dashboard')
  async getDashboard() {
    return this.adminService.getDashboardStats();
  }

  /**
   * Obtener todos los usuarios con estadísticas básicas
   */
  @Get('users')
  async getAllUsers() {
    return this.adminService.getAllUsersWithStats();
  }

  /**
   * Obtener logs de actividad de un usuario específico
   */
  @Get('users/:userId/activity')
  async getUserActivity(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getUserActivityLogs(
      userId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Obtener números autorizados de un usuario con paginación
   */
  @Get('users/:userId/numbers')
  async getUserNumbers(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getUserAuthorizedNumbersPaginated(
      userId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      search || undefined,
    );
  }

  /**
   * Obtener estadísticas detalladas de un usuario
   */
  @Get('users/:userId/stats')
  async getUserStats(@Param('userId', ParseIntPipe) userId: number) {
    return this.adminService.getUserDetailedStats(userId);
  }

  /**
   * Obtener estadísticas de un número específico
   */
  @Get('users/:userId/numbers/:numberId/stats')
  async getNumberStats(
    @Param('userId', ParseIntPipe) userId: number,
    @Param('numberId', ParseIntPipe) numberId: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.adminService.getNumberStats(
      userId,
      numberId,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  /**
   * Obtener historial de mensajes de un número específico con paginación
   */
  @Get('users/:userId/numbers/:numberId/messages')
  async getNumberMessages(
    @Param('userId', ParseIntPipe) userId: number,
    @Param('numberId', ParseIntPipe) numberId: number,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.adminService.getNumberMessagesPaginated(
      userId,
      numberId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 10,
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );
  }

  /**
   * Actualizar permisos de admin de un usuario
   */
  @Put('users/:userId/admin')
  async updateUserAdminStatus(
    @Param('userId', ParseIntPipe) targetUserId: number,
    @Body('isAdmin') isAdmin: boolean,
    @GetUser() adminUser: UserEntity,
  ) {
    await this.adminService.updateUserAdminStatus(targetUserId, isAdmin, adminUser.id);
    return { success: true, message: `Usuario ${isAdmin ? 'promovido a' : 'removido de'} administrador` };
  }
}
