/**
 * Company news.
 *
 * Registered as a module of its own rather than folded into core, because it
 * has a permission, a navigation entry and a portlet, and those are exactly the
 * things the hub registry exists to carry. It depends on core for the bucket
 * and the notification bell, and on nothing else.
 */
import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { CurrentUser, Permissions, type Principal } from '../../common/auth';
import { registerHubModule } from '../../core/hub-registry';
import { AnnouncementsService } from './announcements.service';
import {
  CommentOnAnnouncement, ReactToAnnouncement, CreateAnnouncement, ListAnnouncements,
  ReorderImages, RequestImageUpload, UpdateAnnouncement,
} from './dto';

export const ANNOUNCEMENTS_MODULE = registerHubModule({
  key: 'announcements',
  name: 'Company News',
  nameAr: 'أخبار الشركة',
  version: '1.0.0',
  apiPrefix: '/api/v1/news',
  tablePrefix: 'hr_',
  enabled: true,
  navigation: [
    /* Reading is for everyone. Writing happens inside this page: whoever may
       publish gets the composer there. */
    { label: 'Company News', labelAr: 'أخبار الشركة', path: '/news', icon: 'bell' },

    /*
     * And a second entry, for whoever looks after the board.
     *
     * This path existed once before and was removed, because there was no page
     * at /news/manage: the router read "manage" as /news/:id and the API
     * rejected it as a malformed id. Both halves of that are fixed now -- the
     * route is declared ahead of /news/:id, and the page exists -- and the
     * entry earns its place rather than duplicating the first, because the
     * two screens answer different questions. /news is the board as the
     * company sees it; this is everything that exists, drafts and taken-down
     * notices included.
     */
    { label: 'Manage News', labelAr: 'إدارة الأخبار', path: '/news/manage',
      icon: 'settings', requiresAnyPermission: ['announcements.manage'] },
  ],
  portlets: [
    /* Wide and first. A noticeboard below the fold is a noticeboard nobody
       reads, and this is the one portlet whose whole purpose is to be seen
       before anything is looked for. */
    { key: 'company-news', title: 'Company News', titleAr: 'أخبار الشركة', width: 12, order: 1 },
  ],
  permissions: [
    { key: 'announcements.manage',
      description: 'Write, publish and take down company announcements, and remove comments on them' },
  ],
});

@Controller('news')
export class AnnouncementsController {
  constructor(private readonly news: AnnouncementsService) {}

  /** What the home page portlet shows. */
  @Get('live')
  live(@CurrentUser() p: Principal, @Query('limit') limit?: string) {
    return this.news.live(p, limit ? parseInt(limit, 10) : 8);
  }

  @Get()
  list(@CurrentUser() p: Principal, @Query() q: ListAnnouncements) {
    return this.news.list(p, { limit: q.limit, offset: q.offset, status: q.status });
  }

  @Get(':id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.news.get(p, id);
  }

  /* --------------------------------------------------------------- writing */

  @Post()
  @Permissions('announcements.manage')
  create(@CurrentUser() p: Principal, @Body() dto: CreateAnnouncement) {
    return this.news.create(p, dto);
  }

  @Patch(':id')
  @Permissions('announcements.manage')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
         @Body() dto: UpdateAnnouncement) {
    return this.news.update(p, id, dto);
  }

  /** Put it on the board, and ring the bell once. */
  @Post(':id/publish')
  @Permissions('announcements.manage')
  publish(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.news.publish(p, id);
  }

  @Post(':id/archive')
  @Permissions('announcements.manage')
  archive(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.news.archive(p, id);
  }

  @Delete(':id')
  @Permissions('announcements.manage')
  remove(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.news.remove(p, id);
  }

  /* ---------------------------------------------------------------- images */

  @Post(':id/images')
  @Permissions('announcements.manage')
  requestUpload(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
                @Body() dto: RequestImageUpload) {
    return this.news.requestImageUpload(p, id, dto);
  }

  @Post('images/:imageId/confirm')
  @Permissions('announcements.manage')
  confirmImage(@CurrentUser() p: Principal, @Param('imageId', ParseUUIDPipe) imageId: string) {
    return this.news.confirmImage(p, imageId);
  }

  @Delete('images/:imageId')
  @Permissions('announcements.manage')
  removeImage(@CurrentUser() p: Principal, @Param('imageId', ParseUUIDPipe) imageId: string) {
    return this.news.removeImage(p, imageId);
  }

  @Post(':id/images/order')
  @Permissions('announcements.manage')
  reorder(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
          @Body() dto: ReorderImages) {
    return this.news.reorderImages(p, id, dto.imageIds);
  }

  /* -------------------------------------------------------------- comments */
  /* No permission: replying is for everybody. Who may remove one is decided in
     the service, because it depends on who wrote it. */

  @Get(':id/comments')
  comments(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.news.comments(p, id);
  }

  /** Reacting is for everybody: no permission, and it works on what is up. */
  @Post(':id/reactions')
  react(@CurrentUser() p: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: ReactToAnnouncement) {
    return this.news.react(p, id, dto.kind);
  }

  @Post(':id/comments')
  comment(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string,
          @Body() dto: CommentOnAnnouncement) {
    return this.news.comment(p, id, dto.body);
  }

  @Delete('comments/:commentId')
  removeComment(@CurrentUser() p: Principal,
                @Param('commentId', ParseUUIDPipe) commentId: string) {
    return this.news.removeComment(p, commentId);
  }
}