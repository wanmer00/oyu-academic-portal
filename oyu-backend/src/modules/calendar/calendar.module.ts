import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { AdminCalendarController, MyCalendarController } from './calendar.controller';

@Module({
  controllers: [MyCalendarController, AdminCalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
