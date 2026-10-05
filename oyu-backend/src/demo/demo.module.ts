import { Module } from '@nestjs/common';
import { TimetableModule } from '../modules/timetable/timetable.module';
import { DemoController } from './demo.controller';
import { DemoResetService } from './demo-reset.service';

@Module({ imports: [TimetableModule], controllers: [DemoController], providers: [DemoResetService], exports: [DemoResetService] })
export class DemoModule {}