import { Injectable, Logger, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual, FindOptionsWhere } from 'typeorm';
import { UserEntity } from '../users/user.entity';
import { UserActivityLogEntity, ActivityType } from './user-activity-log.entity';
import { MessageStatsEntity, MessageDirection, MessageType } from './message-stats.entity';
import { AuthorizedNumberEntity } from '../config/authorized-number.entity';
import { ModuleRef } from '@nestjs/core';

export interface UserWithStats {
  id: number;
  email: string;
  nombre: string;
  numero: string;
  isAdmin: boolean;
  createdAt: Date;
  lastActivity?: Date;
  isCurrentlyLoggedIn: boolean;
  totalAuthorizedNumbers: number;
}

export interface UserActivitySummary {
  userId: number;
  email: string;
  nombre: string;
  activities: UserActivityLogEntity[];
  isCurrentlyLoggedIn: boolean;
  lastLoginAt?: Date;
  lastLogoutAt?: Date;
}

export interface AuthorizedNumberWithStats {
  id: number;
  phoneNumber: string;
  firstName: string;
  lastName: string;
  dni: string;
  entityName: string;
  position: string;
  canSendExcel: boolean;
  canRequestInfo: boolean;
  createdAt: Date;
  stats: {
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalExcelUploads: number;
    totalSearchRequests: number;
  };
}

export interface UserDetailedStats {
  userId: number;
  email: string;
  nombre: string;
  authorizedNumbers: AuthorizedNumberWithStats[];
  totals: {
    totalNumbers: number;
    totalMessagesReceived: number;
    totalMessagesSent: number;
    totalExcelUploads: number;
    totalSearchRequests: number;
  };
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(UserActivityLogEntity)
    private readonly activityRepo: Repository<UserActivityLogEntity>,
    @InjectRepository(MessageStatsEntity)
    private readonly messageStatsRepo: Repository<MessageStatsEntity>,
    @InjectRepository(AuthorizedNumberEntity)
    private readonly authorizedNumberRepo: Repository<AuthorizedNumberEntity>,
    private readonly moduleRef: ModuleRef,
  ) {}

  private async getWhatsAppGateway() {
    try {
      // Usar import estático en lugar de dinámico para TypeScript
      return this.moduleRef.get('WhatsAppGateway', { strict: false });
    } catch (error) {
      this.logger.warn('WhatsAppGateway no disponible para notificaciones');
      return null;
    }
  }

  /**
   * Verifica que el usuario sea admin
   */
  async verifyAdmin(userId: number): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || !user.isAdmin) {
      throw new ForbiddenException('Acceso denegado. Se requieren permisos de administrador.');
    }
  }

  /**
   * Registrar actividad de usuario (login/logout)
   */
  async logActivity(
    userId: number,
    activityType: ActivityType,
    ipAddress?: string,
    userAgent?: string,
    details?: string,
  ): Promise<void> {
    const log = new UserActivityLogEntity();
    log.userId = userId;
    log.activityType = activityType;
    log.ipAddress = ipAddress || '';
    log.userAgent = userAgent || '';
    log.details = details || '';
    
    await this.activityRepo.save(log);
    this.logger.log(`📊 [ADMIN] Actividad registrada: ${activityType} para usuario ${userId}`);
  }

  /**
   * Registrar estadística de mensaje
   */
  async logMessageStat(
    userId: number,
    authorizedNumberId: number,
    phoneNumber: string,
    direction: MessageDirection,
    messageType: MessageType,
    details?: string,
  ): Promise<void> {
    const stat = new MessageStatsEntity();
    stat.userId = userId;
    stat.authorizedNumberId = authorizedNumberId;
    stat.phoneNumber = phoneNumber;
    stat.direction = direction;
    stat.messageType = messageType;
    stat.details = details || '';
    
    await this.messageStatsRepo.save(stat);
  }

  /**
   * Obtener todos los usuarios con estadísticas básicas
   */
  async getAllUsersWithStats(): Promise<UserWithStats[]> {
    const users = await this.userRepo.find({
      order: { createdAt: 'DESC' },
    });

    const result: UserWithStats[] = [];

    for (const user of users) {
      // Obtener última actividad
      const lastActivity = await this.activityRepo.findOne({
        where: { userId: user.id },
        order: { createdAt: 'DESC' },
      });

      // Verificar si está logueado actualmente (último evento es login)
      const isLoggedIn = lastActivity?.activityType === 'login';

      // Contar números autorizados
      const totalNumbers = await this.authorizedNumberRepo.count({
        where: { userId: user.id },
      });

      result.push({
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        numero: user.numero,
        isAdmin: user.isAdmin,
        createdAt: user.createdAt,
        lastActivity: lastActivity?.createdAt,
        isCurrentlyLoggedIn: isLoggedIn,
        totalAuthorizedNumbers: totalNumbers,
      });
    }

    return result;
  }

  /**
   * Obtener logs de actividad de un usuario
   */
  async getUserActivityLogs(
    targetUserId: number,
    startDate?: Date,
    endDate?: Date,
    limit: number = 50,
  ): Promise<UserActivitySummary> {
    const user = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    let whereCondition: FindOptionsWhere<UserActivityLogEntity> = { userId: targetUserId };
    
    if (startDate && endDate) {
      whereCondition.createdAt = Between(startDate, endDate);
    } else if (startDate) {
      whereCondition.createdAt = MoreThanOrEqual(startDate);
    } else if (endDate) {
      whereCondition.createdAt = LessThanOrEqual(endDate);
    }

    const activities = await this.activityRepo.find({
      where: whereCondition,
      order: { createdAt: 'DESC' },
      take: limit,
    });

    // Último login y logout
    const lastLogin = await this.activityRepo.findOne({
      where: { userId: targetUserId, activityType: 'login' },
      order: { createdAt: 'DESC' },
    });

    const lastLogout = await this.activityRepo.findOne({
      where: { userId: targetUserId, activityType: 'logout' },
      order: { createdAt: 'DESC' },
    });

    // Determinar si está logueado
    const isLoggedIn = !!(lastLogin && (!lastLogout || lastLogin.createdAt > lastLogout.createdAt));

    return {
      userId: user.id,
      email: user.email,
      nombre: user.nombre,
      activities,
      isCurrentlyLoggedIn: isLoggedIn,
      lastLoginAt: lastLogin?.createdAt,
      lastLogoutAt: lastLogout?.createdAt,
    };
  }

  /**
   * Obtener lista de números autorizados de un usuario
   */
  async getUserAuthorizedNumbers(targetUserId: number): Promise<AuthorizedNumberEntity[]> {
    return this.authorizedNumberRepo.find({
      where: { userId: targetUserId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Obtener números autorizados con paginación y búsqueda
   */
  async getUserAuthorizedNumbersPaginated(
    targetUserId: number,
    page: number = 1,
    limit: number = 10,
    search?: string,
  ): Promise<{
    data: AuthorizedNumberWithStats[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;
    
    const queryBuilder = this.authorizedNumberRepo
      .createQueryBuilder('an')
      .where('an.userId = :userId', { userId: targetUserId });

    // Búsqueda por teléfono, nombre, apellido, DNI o entidad
    if (search && search.trim()) {
      const searchTerm = `%${search.trim().toLowerCase()}%`;
      queryBuilder.andWhere(
        '(LOWER(an.phoneNumber) LIKE :search OR LOWER(an.firstName) LIKE :search OR LOWER(an.lastName) LIKE :search OR LOWER(an.dni) LIKE :search OR LOWER(an.entityName) LIKE :search)',
        { search: searchTerm }
      );
    }

    const [numbers, total] = await queryBuilder
      .orderBy('an.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    // Agregar estadísticas para cada número
    const numbersWithStats: AuthorizedNumberWithStats[] = [];
    
    for (const number of numbers) {
      // Estadísticas para este número
      const received = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, direction: 'incoming' },
      });

      const sent = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, direction: 'outgoing' },
      });

      const excel = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, messageType: 'excel' },
      });

      const search = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, messageType: 'search_request' },
      });

      numbersWithStats.push({
        id: number.id,
        phoneNumber: number.phoneNumber,
        firstName: number.firstName || '',
        lastName: number.lastName || '',
        dni: number.dni || '',
        entityName: number.entityName || '',
        position: number.position || '',
        canSendExcel: number.canSendExcel,
        canRequestInfo: number.canRequestInfo,
        createdAt: number.createdAt,
        stats: {
          totalMessagesReceived: received,
          totalMessagesSent: sent,
          totalExcelUploads: excel,
          totalSearchRequests: search,
        },
      });
    }

    return {
      data: numbersWithStats,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Obtener historial de mensajes de un número específico con paginación
   */
  async getNumberMessagesPaginated(
    targetUserId: number,
    numberId: number,
    page: number = 1,
    limit: number = 10,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    data: MessageStatsEntity[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    number: AuthorizedNumberEntity;
  }> {
    // Verificar que el número pertenece al usuario
    const number = await this.authorizedNumberRepo.findOne({
      where: { id: numberId, userId: targetUserId },
    });

    if (!number) {
      throw new Error('Número no encontrado');
    }

    const skip = (page - 1) * limit;
    
    let whereCondition: FindOptionsWhere<MessageStatsEntity> = { authorizedNumberId: numberId };
    
    if (startDate && endDate) {
      whereCondition.createdAt = Between(startDate, endDate);
    } else if (startDate) {
      whereCondition.createdAt = MoreThanOrEqual(startDate);
    } else if (endDate) {
      whereCondition.createdAt = LessThanOrEqual(endDate);
    }

    const [messages, total] = await this.messageStatsRepo.findAndCount({
      where: whereCondition,
      order: { createdAt: 'DESC' },
      skip: skip,
      take: limit,
    });

    return {
      data: messages,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      number,
    };
  }

  /**
   * Obtener estadísticas detalladas de mensajes por usuario
   */
  async getUserDetailedStats(targetUserId: number): Promise<UserDetailedStats> {
    const user = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    const authorizedNumbers = await this.authorizedNumberRepo.find({
      where: { userId: targetUserId },
      order: { createdAt: 'DESC' },
    });

    const numbersWithStats: AuthorizedNumberWithStats[] = [];
    let totalReceived = 0;
    let totalSent = 0;
    let totalExcel = 0;
    let totalSearch = 0;

    for (const number of authorizedNumbers) {
      // Estadísticas para este número
      const received = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, direction: 'incoming' },
      });

      const sent = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, direction: 'outgoing' },
      });

      const excel = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, messageType: 'excel' },
      });

      const search = await this.messageStatsRepo.count({
        where: { authorizedNumberId: number.id, messageType: 'search_request' },
      });

      totalReceived += received;
      totalSent += sent;
      totalExcel += excel;
      totalSearch += search;

      numbersWithStats.push({
        id: number.id,
        phoneNumber: number.phoneNumber,
        firstName: number.firstName || '',
        lastName: number.lastName || '',
        dni: number.dni || '',
        entityName: number.entityName || '',
        position: number.position || '',
        canSendExcel: number.canSendExcel,
        canRequestInfo: number.canRequestInfo,
        createdAt: number.createdAt,
        stats: {
          totalMessagesReceived: received,
          totalMessagesSent: sent,
          totalExcelUploads: excel,
          totalSearchRequests: search,
        },
      });
    }

    return {
      userId: user.id,
      email: user.email,
      nombre: user.nombre,
      authorizedNumbers: numbersWithStats,
      totals: {
        totalNumbers: authorizedNumbers.length,
        totalMessagesReceived: totalReceived,
        totalMessagesSent: totalSent,
        totalExcelUploads: totalExcel,
        totalSearchRequests: totalSearch,
      },
    };
  }

  /**
   * Obtener estadísticas de un número específico
   */
  async getNumberStats(
    targetUserId: number,
    numberId: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    number: AuthorizedNumberEntity;
    messageHistory: MessageStatsEntity[];
    stats: {
      totalReceived: number;
      totalSent: number;
      totalExcel: number;
      totalSearch: number;
    };
  }> {
    const number = await this.authorizedNumberRepo.findOne({
      where: { id: numberId, userId: targetUserId },
    });

    if (!number) {
      throw new Error('Número no encontrado');
    }

    let whereCondition: FindOptionsWhere<MessageStatsEntity> = { authorizedNumberId: numberId };
    
    if (startDate && endDate) {
      whereCondition.createdAt = Between(startDate, endDate);
    } else if (startDate) {
      whereCondition.createdAt = MoreThanOrEqual(startDate);
    } else if (endDate) {
      whereCondition.createdAt = LessThanOrEqual(endDate);
    }

    const messageHistory = await this.messageStatsRepo.find({
      where: whereCondition,
      order: { createdAt: 'DESC' },
      take: 100,
    });

    const totalReceived = await this.messageStatsRepo.count({
      where: { ...whereCondition, direction: 'incoming' },
    });

    const totalSent = await this.messageStatsRepo.count({
      where: { ...whereCondition, direction: 'outgoing' },
    });

    const totalExcel = await this.messageStatsRepo.count({
      where: { ...whereCondition, messageType: 'excel' },
    });

    const totalSearch = await this.messageStatsRepo.count({
      where: { ...whereCondition, messageType: 'search_request' },
    });

    return {
      number,
      messageHistory,
      stats: {
        totalReceived,
        totalSent,
        totalExcel,
        totalSearch,
      },
    };
  }

  /**
   * Actualizar permisos de admin de un usuario
   */
  async updateUserAdminStatus(targetUserId: number, isAdmin: boolean, adminUserId: number): Promise<void> {
    // Verificar que quien hace el cambio es admin
    await this.verifyAdmin(adminUserId);

    // Obtener el usuario objetivo
    const user = await this.userRepo.findOne({ where: { id: targetUserId } });
    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    // Actualizar el estado de admin
    user.isAdmin = isAdmin;
    await this.userRepo.save(user);

    // Registrar la actividad
    await this.logActivity(
      adminUserId,
      'user_updated' as ActivityType,
      undefined,
      undefined,
      `Usuario ${user.email} ${isAdmin ? 'promovido a' : 'removido de'} administrador`
    );

    // Notificar al usuario afectado vía WebSocket si el gateway está disponible
    const whatsappGateway = await this.getWhatsAppGateway();
    if (whatsappGateway) {
      const userData = {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        numero: user.numero,
        isAdmin: user.isAdmin,
      };
      
      whatsappGateway.emitUserUpdatedToUser(targetUserId, userData);
      this.logger.log(`🔔 Notificación de actualización enviada al usuario ${targetUserId} (isAdmin: ${isAdmin})`);
    }

    this.logger.log(`👥 Usuario ${user.email} ${isAdmin ? 'promovido a' : 'removido de'} administrador por usuario ${adminUserId}`);
  }

  /**
   * Dashboard resumen para admin
   */
  async getDashboardStats(): Promise<{
    totalUsers: number;
    activeUsers: number;
    totalAuthorizedNumbers: number;
    totalMessages: number;
    recentActivity: UserActivityLogEntity[];
  }> {
    const totalUsers = await this.userRepo.count();
    
    // Usuarios activos (con login en las últimas 24h)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const recentLogins = await this.activityRepo
      .createQueryBuilder('log')
      .select('DISTINCT log.userId')
      .where('log.activityType = :type', { type: 'login' })
      .andWhere('log.createdAt >= :date', { date: yesterday })
      .getRawMany();
    
    const activeUsers = recentLogins.length;

    const totalAuthorizedNumbers = await this.authorizedNumberRepo.count();
    const totalMessages = await this.messageStatsRepo.count();

    const recentActivity = await this.activityRepo.find({
      order: { createdAt: 'DESC' },
      take: 20,
    });

    return {
      totalUsers,
      activeUsers,
      totalAuthorizedNumbers,
      totalMessages,
      recentActivity,
    };
  }
}
