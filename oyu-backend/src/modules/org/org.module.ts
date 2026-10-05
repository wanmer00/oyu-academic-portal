import { Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { AcademicController } from './academic.controller';
import { AcademicService } from './academic.service';

@Module({ controllers: [OrgController, AcademicController], providers: [AcademicService], exports: [AcademicService] })
export class OrgModule {}
