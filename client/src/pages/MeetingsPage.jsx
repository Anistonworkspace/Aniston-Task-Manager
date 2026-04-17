import React, { useState, useEffect } from 'react';
import {
  CalendarPlus, Clock, MapPin, Users, CheckCircle2, XCircle,
  Pencil, Trash2, MoreHorizontal, Video, Bell, GitBranch,
  ChevronLeft, ChevronRight, Check, X,
} from 'lucide-react';
import { format, parseISO, isToday, isPast, isFuture, addDays } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';
import MeetingModal from '../components/meeting/MeetingModal';
import useSocket from '../hooks/useSocket';
import { useToast } from '../components/common/Toast';

const TYPE_CONFIG = {
  meeting: { label: 'Meeting', color: '#0073ea', icon: Video, bg: 'bg-primary/10 text-primary' },
  reminder: { label: 'Reminder', color: '#fdab3d', icon: Bell, bg: 'bg-warning/10 text-warning' },
  follow_up: { label: 'Follow-up', color: '#a25ddc', icon: GitBranch, bg: 'bg-purple/10 text-purple' },
};

const STATUS_CONFIG = {
  scheduled: { label: 'Scheduled', bg: 'bg-primary/10 text-primary' },
  completed: { label: 'Completed', bg: 'bg-success/10 text-success' },
  cancelled: { label: 'Cancelled', bg: 'bg-gray-100 text-gray-500' },
};

export default function MeetingsPage() {
  const { user, canManage } = useAuth();
  const { error: toastError, success: toastSuccess } = useToast();
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('upcoming');
  const [showModal, setShowModal] = useState(false);
  const [editMeeting, setEditMeeting] = useState(null);
  const [actionMenu, setActionMenu] = useState(null);

  useEffect(() => { loadMeetings(); }, []);

  // Live updates
  useSocket('notification:new', () => loadMeetings());

  async function loadMeetings() {
    try {
      setLoading(true);
      const res = await api.get('/meetings/my');
      setMeetings(res.data.meetings || res.data.data?.meetings || []);
    } catch (err) {
      console.error('Failed to load meetings:', err);
      toastError('Failed to load meetings');
    } finally {
      setLoading(false);
    }
  }

  async function handleRespond(meetingId, status) {
    try {
      await api.put(`/meetings/${meetingId}/respond`, { status });
      loadMeetings();
    } catch (err) {
      console.error('Failed to respond:', err);
      toastError('Failed to respond to meeting');
    }
  }

  async function handleDelete(meetingId) {
    if (!confirm('Delete this meeting? Participants will be notified.')) return;
    setActionMenu(null);
    try {
      await api.delete(`/meetings/${meetingId}`);
      toastSuccess('Meeting deleted');
      loadMeetings();
    } catch (err) {
      console.error('Failed to delete:', err);
      toastError('Failed to delete meeting');
    }
  }

  async function handleMarkComplete(meetingId) {
    try {
      await api.put(`/meetings/${meetingId}`, { status: 'completed' });
      loadMeetings();
    } catch (err) {
      console.error('Failed to update:', err);
      toastError('Failed to update meeting');
    }
    setActionMenu(null);
  }

  const today = new Date().toISOString().slice(0, 10);
  const filtered = meetings.filter(m => {
    if (tab === 'upcoming') return m.date >= today && m.status !== 'cancelled';
    if (tab === 'past') return m.date < today || m.status === 'completed';
    return true;
  });

  const grouped = {};
  filtered.forEach(m => {
    const key = m.date;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(m);
  });
  const sortedDates = Object.keys(grouped).sort((a, b) => tab === 'past' ? b.localeCompare(a) : a.localeCompare(b));

  return (
    <div className="p-6 max-w-[1000px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Meetings</h1>
          <p className="text-sm text-text-secondary mt-0.5">Schedule and manage meetings, reminders, and follow-ups</p>
        </div>
        {canManage && (
          <button onClick={() => { setEditMeeting(null); setShowModal(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover transition-colors shadow-sm">
            <CalendarPlus size={16} /> Schedule Meeting
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total', value: meetings.length, color: '#0073ea' },
          { label: 'Upcoming', value: meetings.filter(m => m.date >= today && m.status === 'scheduled').length, color: '#fdab3d' },
          { label: 'Today', value: meetings.filter(m => m.date === today).length, color: '#00c875' },
          { label: 'Completed', value: meetings.filter(m => m.status === 'completed').length, color: '#a25ddc' },
        ].map(s => (
          <div key={s.label} className="widget-card">
            <p className="text-xs text-text-secondary font-medium mb-1">{s.label}</p>
            <p className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-border">
        {['upcoming', 'past', 'all'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px capitalize transition-colors ${tab === t ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Meeting List */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-border">
          <CalendarPlus size={40} className="mx-auto text-text-tertiary mb-3" />
          <p className="text-text-secondary font-medium">No meetings {tab !== 'all' ? tab : ''}</p>
          <p className="text-sm text-text-tertiary mt-1">
            {canManage ? 'Schedule a new meeting to get started' : 'No meetings scheduled for you yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {sortedDates.map(dateStr => {
            const dayMeetings = grouped[dateStr];
            const d = parseISO(dateStr);
            const isTodays = isToday(d);
            return (
              <div key={dateStr}>
                <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isTodays ? 'text-primary' : 'text-text-tertiary'}`}>
                  {isTodays ? 'Today' : format(d, 'EEEE, MMMM d, yyyy')}
                  {isTodays && <span className="text-text-tertiary ml-2 normal-case tracking-normal">{format(d, 'MMMM d, yyyy')}</span>}
                </h3>
                <div className="space-y-2">
                  {dayMeetings.map(meeting => {
                    const typeCfg = TYPE_CONFIG[meeting.type] || TYPE_CONFIG.meeting;
                    const statusCfg = STATUS_CONFIG[meeting.status] || STATUS_CONFIG.scheduled;
                    const TypeIcon = typeCfg.icon;
                    const isOrganizer = meeting.createdBy === user?.id;
                    const myParticipant = meeting.participants?.filter(Boolean)?.find(p => p.userId === user?.id);
                    const isPastMeeting = meeting.date < today;

                    return (
                      <div key={meeting.id} className="bg-white rounded-xl border border-border shadow-sm hover:shadow-md transition-shadow">
                        <div className="flex">
                          {/* Color bar */}
                          <div className="w-1 flex-shrink-0 rounded-l-xl" style={{ backgroundColor: typeCfg.color }} />

                          <div className="flex-1 p-4">
                            <div className="flex items-start justify-between gap-3">
                              {/* Main Info */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <h4 className="text-sm font-semibold text-text-primary truncate">{meeting.title}</h4>
                                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${typeCfg.bg}`}>
                                    {typeCfg.label}
                                  </span>
                                  {meeting.status !== 'scheduled' && (
                                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${statusCfg.bg}`}>
                                      {statusCfg.label}
                                    </span>
                                  )}
                                </div>

                                <div className="flex items-center gap-4 text-xs text-text-secondary mb-2">
                                  <span className="flex items-center gap-1">
                                    <Clock size={12} /> {meeting.startTime} - {meeting.endTime}
                                  </span>
                                  {meeting.location && (
                                    <span className="flex items-center gap-1">
                                      <MapPin size={12} /> {meeting.location}
                                    </span>
                                  )}
                                </div>

                                {meeting.description && (
                                  <p className="text-xs text-text-tertiary mb-2 line-clamp-2">{meeting.description}</p>
                                )}

                                {/* Linked task/board */}
                                <div className="flex items-center gap-2 flex-wrap">
                                  {meeting.board && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface border border-border text-text-secondary">
                                      {meeting.board.name}
                                    </span>
                                  )}
                                  {meeting.task && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface border border-border text-text-secondary">
                                      {meeting.task.title}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Right side */}
                              <div className="flex flex-col items-end gap-2 flex-shrink-0">
                                {/* Organizer */}
                                <div className="flex items-center gap-1.5">
                                  {meeting.organizer && (
                                    <div className="flex items-center gap-1" title={`Organized by ${meeting.organizer.name}`}>
                                      <Avatar name={meeting.organizer.name} size="xs" />
                                      <span className="text-[10px] text-text-tertiary">{isOrganizer ? 'You' : meeting.organizer.name.split(' ')[0]}</span>
                                    </div>
                                  )}
                                </div>

                                {/* Participants */}
                                {meeting.participants?.filter(Boolean)?.length > 0 && (
                                  <div className="flex -space-x-1.5">
                                    {meeting.participants.filter(Boolean).slice(0, 4).map((p, i) => (
                                      <div key={i} title={`${p.name || 'Unknown'} (${p.status || 'pending'})`}
                                        className={`rounded-full ring-2 ring-white ${p.status === 'declined' ? 'opacity-40' : ''}`}>
                                        <Avatar name={p.name || 'Unknown'} size="xs" />
                                      </div>
                                    ))}
                                    {meeting.participants.filter(Boolean).length > 4 && (
                                      <div className="w-6 h-6 rounded-full bg-surface border-2 border-white flex items-center justify-center text-[9px] font-medium text-text-secondary">
                                        +{meeting.participants.length - 4}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* Actions */}
                                <div className="flex items-center gap-1">
                                  {/* Accept/Decline for participants */}
                                  {myParticipant && myParticipant.status === 'pending' && !isPastMeeting && (
                                    <>
                                      <button onClick={() => handleRespond(meeting.id, 'accepted')}
                                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-success/10 text-success rounded-md hover:bg-success/20 transition-colors"
                                        title="Accept">
                                        <Check size={11} /> Accept
                                      </button>
                                      <button onClick={() => handleRespond(meeting.id, 'declined')}
                                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-danger/10 text-danger rounded-md hover:bg-danger/20 transition-colors"
                                        title="Decline">
                                        <X size={11} /> Decline
                                      </button>
                                    </>
                                  )}
                                  {myParticipant && myParticipant.status === 'accepted' && (
                                    <span className="text-[10px] font-medium text-success flex items-center gap-0.5">
                                      <CheckCircle2 size={11} /> Accepted
                                    </span>
                                  )}
                                  {myParticipant && myParticipant.status === 'declined' && (
                                    <span className="text-[10px] font-medium text-danger flex items-center gap-0.5">
                                      <XCircle size={11} /> Declined
                                    </span>
                                  )}

                                  {/* Edit/Delete for organizer */}
                                  {(isOrganizer || user?.role === 'admin') && (
                                    <div className="relative ml-1">
                                      <button onClick={() => setActionMenu(actionMenu === meeting.id ? null : meeting.id)}
                                        className="p-1 rounded hover:bg-surface text-text-tertiary">
                                        <MoreHorizontal size={14} />
                                      </button>
                                      {actionMenu === meeting.id && (
                                        <>
                                          <div className="fixed inset-0 z-40" onClick={() => setActionMenu(null)} />
                                          <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-dropdown border border-border py-1 min-w-[150px]">
                                            <button onClick={() => { setEditMeeting(meeting); setShowModal(true); setActionMenu(null); }}
                                              className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-surface">
                                              <Pencil size={13} /> Edit
                                            </button>
                                            {meeting.status === 'scheduled' && (
                                              <button onClick={() => handleMarkComplete(meeting.id)}
                                                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-success hover:bg-success/5">
                                                <CheckCircle2 size={13} /> Mark Complete
                                              </button>
                                            )}
                                            <button onClick={() => handleDelete(meeting.id)}
                                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-danger hover:bg-danger/5">
                                              <Trash2 size={13} /> Delete
                                            </button>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <MeetingModal
          meeting={editMeeting}
          onClose={() => { setShowModal(false); setEditMeeting(null); }}
          onSave={() => loadMeetings()}
        />
      )}
    </div>
  );
}
