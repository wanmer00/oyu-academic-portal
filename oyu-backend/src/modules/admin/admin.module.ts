import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { JournalModule } from '../journal/journal.module';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminDirectoryController } from './admin-directory.controller';
import { AdminDirectoryService } from './admin-directory.service';
import { AdminOverviewService } from './admin-overview.service';
import { AdminRolesController } from './admin-roles.controller';
import { AdminService } from './admin.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [JournalModule, AttendanceModule],
  controllers: [AdminController, AdminUsersController, AdminDirectoryController, AdminRolesController],
  providers: [AdminService, AdminAnalyticsService, AdminOverviewService, AdminUsersService, AdminDirectoryService],
  exports: [AdminService, AdminAnalyticsService, AdminOverviewService],
})
export class AdminModule {}
