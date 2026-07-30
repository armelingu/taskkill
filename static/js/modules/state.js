/**
 * Estado mutável compartilhado entre os módulos de feature (tasks, projects,
 * dashboard, graph) e o main. É um singleton: todos importam o MESMO objeto,
 * então reatribuições (ex.: state.tasksData = ...) são vistas por todos.
 *
 * Mantido pequeno de propósito — só o que precisa cruzar fronteiras de módulo.
 */
export const state = {
    tasksData: {},          // { projeto: [ {id, text, completed, due_date, ...}, ... ] }
    currentCategory: null,  // projeto selecionado
    currentWeekDate: null,  // data ISO YYYY-MM-DD selecionada (visão semana)
    currentWeekStart: null, // segunda-feira ISO da semana visível na faixa
    currentTag: null,       // #tag selecionada (vinda do grafo)
};
